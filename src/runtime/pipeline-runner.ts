/**
 * Pipeline runner — top-level orchestrator that loads, compiles, and executes
 * a complete pipeline with stage dependency ordering, parallel execution,
 * and status tracking.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import chalk from 'chalk';
import type {
  PipelineDefinition,
  StageDefinition,
  JobDefinition,
  RegularJobDefinition,
  PipelineRunContext,
  PipelineStatus,
  StepDefinition,
} from '../types/pipeline.js';
import type { ExpressionEngine } from '../compiler/expression-engine.js';
import { PipelineCompiler } from '../compiler/pipeline-compiler.js';
import { ParameterResolver } from '../compiler/parameter-resolver.js';
import { createExpressionEngine } from '../compiler/expression-engine.js';
import { createFunctionRegistry } from '../functions/index.js';
import { VariableManager } from '../variables/variable-manager.js';
import { OutputVariableStore } from '../variables/output-variables.js';
import { SecretMasker } from '../variables/secret-masker.js';
import {
  DependencyGraph,
  normalizeDependsOn,
  type GraphNode,
} from './dependency-graph.js';
import { StageRunner, type StageRunResult, type StageRunnerDeps } from './stage-runner.js';
import type { StepRunner, StepRunnerOptions } from './step-runner.js';
import type { ConditionEvaluator } from './condition-evaluator.js';

export interface PipelineRunOptions {
  filePath: string;
  params: Record<string, string>;
  workingDirectory: string;
  stageFilter?: string;
  jobFilter?: string;
  dryRun?: boolean;
  verbose?: boolean;
  stepRunnerFactory?: (options: StepRunnerOptions) => StepRunner;
  conditionEvaluator?: ConditionEvaluator;
}

export interface PipelineRunResult {
  status: PipelineStatus;
  exitCode: number;
  duration: number;
  stages: StageRunResult[];
  context: PipelineRunContext;
}

export class PipelineRunner {
  private canceled = false;
  private stageRunners: StageRunner[] = [];

  /**
   * Run a pipeline from a file path.
   */
  async run(options: PipelineRunOptions): Promise<PipelineRunResult> {
    const startTime = Date.now();

    try {
      // 1. Compile the pipeline
      console.log(chalk.bold('Loading pipeline...'));
      const compiler = new PipelineCompiler({
        basePath: path.dirname(path.resolve(options.workingDirectory, options.filePath)),
      });

      const compilationResult = await compiler.compile(options.filePath, options.params);
      const pipeline = compilationResult.pipeline as PipelineDefinition;

      if (compilationResult.warnings.length > 0) {
        for (const warning of compilationResult.warnings) {
          console.log(chalk.yellow(`Warning: ${warning}`));
        }
      }

      // 2. Resolve parameters
      const paramResolver = new ParameterResolver();
      const resolvedParams = paramResolver.resolve(
        pipeline.parameters ?? [],
        options.params,
      );

      if (resolvedParams.errors.length > 0) {
        for (const err of resolvedParams.errors) {
          console.error(chalk.red(`Parameter error: ${err.message}`));
        }
        return this.createFailedResult(startTime);
      }

      for (const warning of resolvedParams.warnings) {
        console.log(chalk.yellow(`Warning: ${warning}`));
      }

      // 3. Initialize variable manager and secret masker
      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      const outputStore = new OutputVariableStore();

      // 4. Set up expression engine with status functions
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'succeeded',
        dependencyResults: {},
        isCanceled: this.canceled,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      // Condition evaluator — injected or must be provided
      if (!options.conditionEvaluator) {
        throw new Error(
          'conditionEvaluator is required in PipelineRunOptions. ' +
          'Inject an instance of ConditionEvaluator.',
        );
      }
      const conditionEvaluator = options.conditionEvaluator;

      // Step runner factory — injected or must be provided
      if (!options.stepRunnerFactory) {
        throw new Error(
          'stepRunnerFactory is required in PipelineRunOptions. ' +
          'Inject a factory function that creates StepRunner instances.',
        );
      }
      const stepRunnerFactory = options.stepRunnerFactory;

      // 5. Initialize pipeline context
      const runId = crypto.randomUUID();
      const pipelineName = pipeline.name ?? path.basename(options.filePath, '.yaml');

      const pipelineContext: PipelineRunContext = {
        runId,
        runNumber: 1,
        pipelineName,
        startTime: new Date(),
        status: 'running',
        stages: new Map(),
      };

      // 6. Initialize system variables
      variableManager.enterScope('pipeline', 'pipeline');
      variableManager.initializeSystemVariables({
        runId,
        runNumber: pipelineContext.runNumber,
        pipelineName,
        workspace: options.workingDirectory,
      });

      // Load pipeline-level variables
      if (pipeline.variables) {
        variableManager.loadVariables(pipeline.variables, 'pipeline');
      }

      // 7. Normalize pipeline structure
      const stages = this.normalizePipeline(pipeline);

      console.log(
        chalk.bold(
          `Pipeline '${pipelineName}' — ${stages.length} stage(s)`,
        ),
      );

      if (options.dryRun) {
        this.printDryRun(stages);
        variableManager.exitScope();
        return {
          status: 'succeeded',
          exitCode: 0,
          duration: Date.now() - startTime,
          stages: [],
          context: pipelineContext,
        };
      }

      // 8. Apply selective execution filters
      let filteredStageIds: Set<string> | null = null;

      if (options.stageFilter || options.jobFilter) {
        filteredStageIds = this.applyFilters(
          stages,
          options.stageFilter,
          options.jobFilter,
        );
      }

      // 9. Build stage dependency graph
      const stageNodes: GraphNode[] = stages.map((s) => ({
        id: s.stage,
        dependsOn: normalizeDependsOn(s.dependsOn),
      }));

      const stageGraph = new DependencyGraph(stageNodes);
      const executionBatches = stageGraph.getExecutionOrder();

      // 10. Execute stages
      const allStageResults: StageRunResult[] = [];

      for (const batch of executionBatches) {
        if (this.canceled) break;

        // Filter batch to only stages we want to run
        const batchStages = batch
          .map((stageId) => stages.find((s) => s.stage === stageId))
          .filter((s): s is StageDefinition => {
            if (!s) return false;
            if (filteredStageIds && !filteredStageIds.has(s.stage)) return false;
            return true;
          });

        if (batchStages.length === 0) continue;

        // Run independent stages in parallel
        const batchPromises = batchStages.map((stage) =>
          this.runSingleStage(
            stage,
            pipelineContext,
            {
              variableManager,
              outputStore,
              expressionEngine,
              conditionEvaluator,
              secretMasker,
              stepRunnerFactory,
            },
            options,
          ),
        );

        const batchResults = await Promise.allSettled(batchPromises);

        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            allStageResults.push(result.value);
          } else {
            console.error(
              chalk.red('Stage execution error:'),
              result.reason,
            );
            allStageResults.push({
              name: 'unknown',
              status: 'failed',
              duration: 0,
              jobs: [],
            });
          }
        }

        // Check if we should stop (non-canceled failed stage without explicit continue)
        const hasFailure = allStageResults.some(
          (r) => r.status === 'failed',
        );
        if (hasFailure && !this.canceled) {
          // Continue to allow downstream stages with explicit conditions to run
          // The dependency graph ensures proper ordering
        }
      }

      // Clean up pipeline scope
      variableManager.exitScope();

      // 11. Determine overall status and exit code
      const pipelineStatus = this.determinePipelineStatus(allStageResults);
      const exitCode = this.statusToExitCode(pipelineStatus);

      pipelineContext.status = pipelineStatus;

      const duration = Date.now() - startTime;

      // 12. Report summary
      this.printSummary(pipelineName, pipelineStatus, duration, allStageResults);

      return {
        status: pipelineStatus,
        exitCode,
        duration,
        stages: allStageResults,
        context: pipelineContext,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`Pipeline error: ${message}`));
      return this.createFailedResult(startTime);
    }
  }

  /**
   * Cancel the pipeline (called from SIGINT handler).
   */
  cancel(): void {
    this.canceled = true;
    console.log(chalk.yellow('\nCancellation requested — stopping pipeline...'));
    for (const runner of this.stageRunners) {
      runner.cancel();
    }
  }

  /**
   * Normalize pipeline structure:
   * - steps-only → wrap in default job → wrap in default stage
   * - jobs-only → wrap in default stage
   * - full pipeline with stages → used as-is
   */
  normalizePipeline(pipeline: PipelineDefinition): StageDefinition[] {
    if (pipeline.stages && pipeline.stages.length > 0) {
      return pipeline.stages;
    }

    if (pipeline.jobs && pipeline.jobs.length > 0) {
      return [
        {
          stage: '__default',
          jobs: pipeline.jobs,
        },
      ];
    }

    if (pipeline.steps && pipeline.steps.length > 0) {
      const defaultJob: RegularJobDefinition = {
        job: '__default',
        steps: pipeline.steps,
      };
      return [
        {
          stage: '__default',
          jobs: [defaultJob],
        },
      ];
    }

    return [];
  }

  private async runSingleStage(
    stage: StageDefinition,
    pipelineContext: PipelineRunContext,
    deps: StageRunnerDeps,
    options: PipelineRunOptions,
  ): Promise<StageRunResult> {
    const stageRunner = new StageRunner(deps, {
      workingDirectory: options.workingDirectory,
      verbose: options.verbose,
    });

    this.stageRunners.push(stageRunner);

    if (this.canceled) {
      stageRunner.cancel();
    }

    return stageRunner.runStage(stage, pipelineContext);
  }

  private applyFilters(
    stages: StageDefinition[],
    stageFilter?: string,
    jobFilter?: string,
  ): Set<string> {
    const stageNodes: GraphNode[] = stages.map((s) => ({
      id: s.stage,
      dependsOn: normalizeDependsOn(s.dependsOn),
    }));

    const stageGraph = new DependencyGraph(stageNodes);
    const result = new Set<string>();

    if (stageFilter) {
      // Include the targeted stage + all its dependencies
      const subgraph = stageGraph.getSubgraph([stageFilter]);
      for (const id of subgraph) {
        result.add(id);
      }
    }

    if (jobFilter) {
      // Find which stage contains the job, then include that stage + dependencies
      for (const stage of stages) {
        const jobs = stage.jobs ?? [];
        for (const job of jobs) {
          const jobName = 'job' in job ? job.job : 'deployment' in job ? job.deployment : null;
          if (jobName === jobFilter) {
            const subgraph = stageGraph.getSubgraph([stage.stage]);
            for (const id of subgraph) {
              result.add(id);
            }
          }
        }
      }
    }

    // If no filter matched, run everything
    if (result.size === 0 && (stageFilter || jobFilter)) {
      const target = stageFilter ?? jobFilter;
      console.warn(
        chalk.yellow(
          `Warning: Filter '${target}' did not match any stage or job. Running all stages.`,
        ),
      );
      for (const stage of stages) {
        result.add(stage.stage);
      }
    }

    return result;
  }

  private determinePipelineStatus(
    stageResults: StageRunResult[],
  ): PipelineStatus {
    if (stageResults.length === 0) return 'succeeded';

    const statuses = stageResults.map((r) => r.status);

    if (this.canceled || statuses.every((s) => s === 'canceled'))
      return 'canceled';
    if (statuses.every((s) => s === 'skipped')) return 'skipped';
    if (statuses.every((s) => s === 'succeeded' || s === 'skipped'))
      return 'succeeded';

    const hasFailed = statuses.some((s) => s === 'failed');
    const hasSucceeded = statuses.some(
      (s) => s === 'succeeded' || s === 'succeededWithIssues',
    );

    if (hasFailed && hasSucceeded) return 'succeededWithIssues';
    if (hasFailed) return 'failed';
    if (statuses.some((s) => s === 'succeededWithIssues'))
      return 'succeededWithIssues';

    return 'failed';
  }

  private statusToExitCode(status: PipelineStatus): number {
    switch (status) {
      case 'succeeded':
        return 0;
      case 'failed':
      case 'canceled':
        return 1;
      case 'succeededWithIssues':
        return 2;
      case 'skipped':
        return 0;
      default:
        return 1;
    }
  }

  private printSummary(
    pipelineName: string,
    status: PipelineStatus,
    duration: number,
    stageResults: StageRunResult[],
  ): void {
    console.log('');
    console.log(chalk.bold('═══════════════════════════════════════════'));
    console.log(chalk.bold(`Pipeline: ${pipelineName}`));

    const statusColor = status === 'succeeded'
      ? chalk.green
      : status === 'failed'
        ? chalk.red
        : status === 'canceled'
          ? chalk.yellow
          : chalk.yellow;

    console.log(chalk.bold(`Status:   ${statusColor(status)}`));
    console.log(
      chalk.bold(
        `Duration: ${(duration / 1000).toFixed(1)}s`,
      ),
    );

    if (stageResults.length > 0) {
      console.log(chalk.bold('───────────────────────────────────────────'));
      for (const stage of stageResults) {
        const stageColor = stage.status === 'succeeded'
          ? chalk.green
          : stage.status === 'failed'
            ? chalk.red
            : chalk.yellow;
        const jobSummary = stage.jobs
          .map((j) => {
            const jColor = j.status === 'succeeded'
              ? chalk.green
              : j.status === 'failed'
                ? chalk.red
                : chalk.yellow;
            return jColor(j.name);
          })
          .join(', ');

        console.log(
          `  ${stageColor('●')} ${stage.name} — ${stageColor(stage.status)}${jobSummary ? ` [${jobSummary}]` : ''}`,
        );
      }
    }

    console.log(chalk.bold('═══════════════════════════════════════════'));
  }

  private printDryRun(stages: StageDefinition[]): void {
    console.log(chalk.bold('\nDry run — execution plan:'));
    for (const stage of stages) {
      console.log(`  Stage: ${chalk.magenta(stage.stage)}`);
      if (stage.dependsOn) {
        const deps = Array.isArray(stage.dependsOn)
          ? stage.dependsOn
          : [stage.dependsOn];
        console.log(`    depends on: ${deps.join(', ')}`);
      }
      for (const job of stage.jobs ?? []) {
        const jobName = 'job' in job
          ? job.job
          : 'deployment' in job
            ? job.deployment
            : 'template';
        console.log(`    Job: ${chalk.cyan(jobName)}`);
        if ('steps' in job) {
          for (const step of (job as RegularJobDefinition).steps) {
            const stepLabel = this.getStepLabel(step);
            console.log(`      - ${stepLabel}`);
          }
        }
      }
    }
    console.log('');
  }

  private getStepLabel(step: StepDefinition): string {
    if ('pwsh' in step) return `pwsh: ${step.pwsh.substring(0, 60)}`;
    if ('node' in step) return `node: ${step.node.substring(0, 60)}`;
    if ('python' in step) return `python: ${step.python.substring(0, 60)}`;
    if ('task' in step) return `task: ${step.task}`;
    if ('template' in step) return `template: ${step.template}`;
    return 'unknown step';
  }

  private createFailedResult(startTime: number): PipelineRunResult {
    return {
      status: 'failed',
      exitCode: 1,
      duration: Date.now() - startTime,
      stages: [],
      context: {
        runId: 'error',
        runNumber: 0,
        pipelineName: 'error',
        startTime: new Date(),
        status: 'failed',
        stages: new Map(),
      },
    };
  }
}
