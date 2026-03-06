/**
 * Stage runner — executes a single stage by orchestrating its jobs
 * in dependency order with parallel execution of independent jobs.
 */

import chalk from 'chalk';
import type {
  StageDefinition,
  JobDefinition,
  RegularJobDefinition,
  DeploymentJobDefinition,
  PipelineRunContext,
  StageRunContext,
  JobRunContext,
  PipelineStatus,
} from '../types/pipeline.js';
import type { ExpressionContext } from '../types/expressions.js';
import type { ExpressionEngine } from '../compiler/expression-engine.js';
import type { VariableManager } from '../variables/variable-manager.js';
import type { OutputVariableStore } from '../variables/output-variables.js';
import type { SecretMasker } from '../variables/secret-masker.js';
import type { ConditionEvaluator } from './condition-evaluator.js';
import { JobRunner, type JobRunResult, type JobRunnerDeps } from './job-runner.js';
import {
  DependencyGraph,
  normalizeDependsOn,
  type GraphNode,
} from './dependency-graph.js';
import type { StepRunner, StepRunnerOptions } from './step-runner.js';

export interface StageRunResult {
  name: string;
  status: PipelineStatus;
  duration: number;
  jobs: JobRunResult[];
}

export interface StageRunnerOptions {
  workingDirectory: string;
  verbose?: boolean;
}

export interface StageRunnerDeps {
  variableManager: VariableManager;
  outputStore: OutputVariableStore;
  expressionEngine: ExpressionEngine;
  conditionEvaluator: ConditionEvaluator;
  secretMasker: SecretMasker;
  stepRunnerFactory: (options: StepRunnerOptions) => StepRunner;
}

export class StageRunner {
  private canceled = false;
  private readonly jobRunners: JobRunner[] = [];

  constructor(
    private readonly deps: StageRunnerDeps,
    private readonly options: StageRunnerOptions,
  ) {}

  cancel(): void {
    this.canceled = true;
    for (const runner of this.jobRunners) {
      runner.cancel();
    }
  }

  async runStage(
    stage: StageDefinition,
    pipelineContext: PipelineRunContext,
  ): Promise<StageRunResult> {
    const stageName = stage.stage;
    const startTime = Date.now();
    const prefix = chalk.magenta(`[${stageName}]`);

    if (this.canceled) {
      this.log(prefix, chalk.yellow('Skipped (pipeline canceled)'));
      return { name: stageName, status: 'canceled', duration: 0, jobs: [] };
    }

    // Enter stage scope
    this.deps.variableManager.enterScope('stage', stageName);

    try {
      // Load stage-level variables
      if (stage.variables) {
        this.deps.variableManager.loadVariables(stage.variables, 'stage');
      }

      // Build expression context for condition evaluation
      const exprContext = this.buildExpressionContext(pipelineContext);

      // Evaluate stage condition
      const shouldRun = this.deps.conditionEvaluator.evaluate(
        stage.condition,
        exprContext,
        this.deps.conditionEvaluator.getDefaultCondition(),
      );

      if (!shouldRun) {
        this.log(prefix, chalk.yellow('Skipped (condition evaluated to false)'));
        return {
          name: stageName,
          status: 'skipped',
          duration: Date.now() - startTime,
          jobs: [],
        };
      }

      this.log(prefix, chalk.green('Starting stage'));

      const jobs = stage.jobs ?? [];
      if (jobs.length === 0) {
        this.log(prefix, chalk.yellow('No jobs to execute'));
        return {
          name: stageName,
          status: 'succeeded',
          duration: Date.now() - startTime,
          jobs: [],
        };
      }

      // Filter to executable jobs (regular + deployment, skip template refs)
      const executableJobs = jobs.filter(
        (j): j is RegularJobDefinition | DeploymentJobDefinition =>
          'job' in j || 'deployment' in j,
      );

      // Create stage run context for job tracking
      const stageRunContext: StageRunContext = {
        name: stageName,
        status: 'running',
        jobs: new Map(),
      };

      // Register stage context in pipeline context
      pipelineContext.stages.set(stageName, stageRunContext);

      // Build job dependency graph
      const graphNodes: GraphNode[] = executableJobs.map((j) => ({
        id: this.getJobName(j),
        dependsOn: normalizeDependsOn(j.dependsOn),
      }));

      const graph = new DependencyGraph(graphNodes);
      const executionBatches = graph.getExecutionOrder();

      // Execute jobs in topological order
      const allJobResults: JobRunResult[] = [];

      for (const batch of executionBatches) {
        if (this.canceled) break;

        const batchJobs = batch
          .map((jobId) =>
            executableJobs.find((j) => this.getJobName(j) === jobId),
          )
          .filter(
            (j): j is RegularJobDefinition | DeploymentJobDefinition =>
              j !== undefined,
          );

        // Run independent jobs in parallel
        const batchPromises = batchJobs.map((job) =>
          this.runSingleJob(job, stageRunContext, pipelineContext),
        );

        const batchResults = await Promise.allSettled(batchPromises);

        for (const result of batchResults) {
          if (result.status === 'fulfilled') {
            const jobResult = result.value;
            allJobResults.push(jobResult);

            // Update stage run context
            const jobRunContext: JobRunContext = {
              name: jobResult.name,
              status: jobResult.status,
              outputs: new Map(
                Object.entries(
                  this.deps.outputStore.getJobOutputs(jobResult.name),
                ),
              ),
              steps: [],
            };
            stageRunContext.jobs.set(jobResult.name, jobRunContext);

            // Record stage-level job result for cross-stage references
            this.deps.outputStore.setStageLevelJobResult(
              stageName,
              jobResult.name,
              this.statusToResultLabel(jobResult.status),
            );
          } else {
            // Job promise rejected (unexpected error)
            const errorResult: JobRunResult = {
              name: 'unknown',
              status: 'failed',
              duration: 0,
              steps: [],
            };
            allJobResults.push(errorResult);
            console.error(
              `${prefix} ${chalk.red('Job execution error:')}`,
              result.reason,
            );
          }
        }
      }

      // Determine stage status from job results
      const stageStatus = this.determineStageStatus(allJobResults);
      stageRunContext.status = stageStatus;

      const duration = Date.now() - startTime;
      const statusColor = stageStatus === 'succeeded'
        ? chalk.green
        : stageStatus === 'failed'
          ? chalk.red
          : chalk.yellow;
      this.log(
        prefix,
        statusColor(`Completed with status: ${stageStatus} (${(duration / 1000).toFixed(1)}s)`),
      );

      return {
        name: stageName,
        status: stageStatus,
        duration,
        jobs: allJobResults,
      };
    } finally {
      this.deps.variableManager.exitScope();
    }
  }

  private async runSingleJob(
    job: RegularJobDefinition | DeploymentJobDefinition,
    stageContext: StageRunContext,
    pipelineContext: PipelineRunContext,
  ): Promise<JobRunResult> {
    const jobRunnerDeps: JobRunnerDeps = {
      variableManager: this.deps.variableManager,
      outputStore: this.deps.outputStore,
      expressionEngine: this.deps.expressionEngine,
      conditionEvaluator: this.deps.conditionEvaluator,
      secretMasker: this.deps.secretMasker,
      stepRunnerFactory: this.deps.stepRunnerFactory,
    };

    const jobRunner = new JobRunner(jobRunnerDeps, {
      workingDirectory: this.options.workingDirectory,
      verbose: this.options.verbose,
    });

    this.jobRunners.push(jobRunner);

    if (this.canceled) {
      jobRunner.cancel();
    }

    return jobRunner.runJob(job, stageContext, pipelineContext);
  }

  private determineStageStatus(jobResults: JobRunResult[]): PipelineStatus {
    if (jobResults.length === 0) return 'succeeded';

    const statuses = jobResults.map((r) => r.status);

    if (statuses.every((s) => s === 'canceled')) return 'canceled';
    if (statuses.every((s) => s === 'skipped')) return 'skipped';
    if (statuses.every((s) => s === 'succeeded' || s === 'skipped'))
      return 'succeeded';

    const hasFailed = statuses.some((s) => s === 'failed');
    const hasSucceeded = statuses.some((s) => s === 'succeeded');
    const hasIssues = statuses.some((s) => s === 'succeededWithIssues');

    if (hasFailed && !hasSucceeded && !hasIssues) return 'failed';
    if (hasFailed || hasIssues) return 'succeededWithIssues';

    return 'failed';
  }

  private getJobName(
    job: RegularJobDefinition | DeploymentJobDefinition,
  ): string {
    if ('job' in job) return job.job;
    if ('deployment' in job) return job.deployment;
    return '__unknown';
  }

  private buildExpressionContext(
    pipelineContext: PipelineRunContext,
  ): ExpressionContext {
    const variables = this.deps.variableManager.toRecord();
    const dependencies =
      this.deps.outputStore.buildStageDependencyContext() as unknown as Record<
        string,
        { result: string; outputs: Record<string, string> }
      >;

    return {
      variables,
      parameters: {},
      dependencies,
      pipeline: {
        'Pipeline.RunId': pipelineContext.runId,
        'Pipeline.RunNumber': String(pipelineContext.runNumber),
        'Pipeline.Name': pipelineContext.pipelineName,
      },
    };
  }

  private statusToResultLabel(status: PipelineStatus): string {
    switch (status) {
      case 'succeeded':
        return 'Succeeded';
      case 'failed':
        return 'Failed';
      case 'canceled':
        return 'Canceled';
      case 'skipped':
        return 'Skipped';
      case 'succeededWithIssues':
        return 'SucceededWithIssues';
      default:
        return 'Succeeded';
    }
  }

  private log(prefix: string, message: string): void {
    console.log(`${prefix} ${message}`);
  }
}
