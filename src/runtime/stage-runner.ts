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
  JobStrategy,
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
import { StrategyRunner } from './strategy-runner.js';
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

      // Inject output variables from upstream stages so they appear in env
      const stageDepContext = this.deps.outputStore.buildStageDependencyContext();
      for (const [, jobEntries] of Object.entries(stageDepContext)) {
        for (const [, { outputs }] of Object.entries(jobEntries)) {
          for (const [outputKey, value] of Object.entries(outputs)) {
            const dotIndex = outputKey.indexOf('.');
            const varName = dotIndex >= 0 ? outputKey.substring(dotIndex + 1) : outputKey;
            this.deps.variableManager.set(varName, value, {
              source: 'output',
            });
          }
        }
      }

      // Build expression context for condition evaluation and variable resolution
      const exprContext = this.buildExpressionContext(pipelineContext);

      // Resolve $[stageDependencies...] runtime expressions in stage-level variables
      this.deps.variableManager.resolveRuntimeExpressions((value) => {
        const result = this.deps.expressionEngine.evaluateRuntime(
          value,
          exprContext,
        );
        return typeof result === 'string' ? result : String(result);
      });

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

            // Promote job outputs to stage level for cross-stage references
            const jobOutputs = this.deps.outputStore.getJobOutputs(jobResult.name);
            for (const [outputKey, value] of Object.entries(jobOutputs)) {
              const dotIndex = outputKey.indexOf('.');
              const stepName = dotIndex >= 0 ? outputKey.substring(0, dotIndex) : '__unknown';
              const varName = dotIndex >= 0 ? outputKey.substring(dotIndex + 1) : outputKey;
              this.deps.outputStore.setStageLevelOutput(
                stageName,
                jobResult.name,
                stepName,
                varName,
                value,
              );
            }
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
    // Check for strategy (matrix/parallel) on regular jobs
    if ('job' in job && job.strategy) {
      const { matrix, parallel } = job.strategy;
      const hasMatrix = typeof matrix === 'string'
        ? matrix.length > 0
        : matrix && Object.keys(matrix).length > 0;
      if (hasMatrix || (parallel !== undefined && parallel > 0)) {
        return this.runStrategyJob(job, stageContext, pipelineContext);
      }
    }

    return this.runJobInstance(job, stageContext, pipelineContext);
  }

  /**
   * Expand a job's strategy (matrix or parallel) into multiple instances
   * and execute them with maxParallel throttling.
   */
  private async runStrategyJob(
    job: RegularJobDefinition,
    stageContext: StageRunContext,
    pipelineContext: PipelineRunContext,
  ): Promise<JobRunResult> {
    const jobName = job.job;
    const prefix = chalk.cyan(`[${stageContext.name}/${jobName}]`);
    const startTime = Date.now();

    // Resolve dynamic matrix from runtime expression (e.g., $[dependencies.Job.outputs['step.matrix']])
    const resolvedStrategy = this.resolveDynamicMatrix(job, pipelineContext, prefix);

    const strategyRunner = new StrategyRunner();
    const expansion = strategyRunner.expandStrategy(jobName, resolvedStrategy);

    this.log(
      prefix,
      chalk.blue(`Expanding strategy: ${expansion.instances.length} instance(s)`),
    );

    const instanceResults = await strategyRunner.runInstances(
      expansion.instances,
      resolvedStrategy.maxParallel,
      async (instance) => {
        // Create a synthetic job definition with instance-specific variables
        const instanceJob: RegularJobDefinition = {
          ...job,
          job: instance.name,
          // Merge instance variables into job variables
          variables: this.mergeInstanceVariables(
            job.variables,
            instance.variables,
          ),
          // Clear strategy so the instance doesn't try to expand again
          strategy: undefined,
        };

        return this.runJobInstance(instanceJob, stageContext, pipelineContext);
      },
    );

    // Aggregate results
    const aggregateStatus = this.determineStrategyStatus(instanceResults);
    const duration = Date.now() - startTime;

    const statusColor =
      aggregateStatus === 'succeeded'
        ? chalk.green
        : aggregateStatus === 'failed'
          ? chalk.red
          : chalk.yellow;
    this.log(
      prefix,
      statusColor(
        `Strategy completed: ${instanceResults.length} instance(s), status: ${aggregateStatus}`,
      ),
    );

    return {
      name: jobName,
      status: aggregateStatus,
      duration,
      steps: instanceResults.flatMap((r) => r.steps),
    };
  }

  /**
   * Merge instance variables (from matrix expansion) into existing job variables.
   * Instance variables are added as simple key-value pairs alongside any existing
   * variable definitions.
   */
  private mergeInstanceVariables(
    existing: RegularJobDefinition['variables'],
    instanceVars: Record<string, string>,
  ): RegularJobDefinition['variables'] {
    const instanceEntries = Object.entries(instanceVars);
    if (instanceEntries.length === 0) return existing;

    // Convert instance vars to VariableDefinition format (simple key-value pairs)
    const instanceDefs = instanceEntries.map(([name, value]) => ({
      name,
      value,
    }));

    if (!existing || (Array.isArray(existing) && existing.length === 0)) {
      return instanceDefs;
    }

    // Existing is an array of VariableDefinition — append instance vars
    if (Array.isArray(existing)) {
      return [...existing, ...instanceDefs];
    }

    // Existing is something else — wrap in array
    return [...instanceDefs];
  }

  /**
   * Determine overall strategy status from individual instance results.
   */
  private determineStrategyStatus(results: JobRunResult[]): PipelineStatus {
    if (results.length === 0) return 'succeeded';
    return this.determineStageStatus(results);
  }

  /**
   * Resolve dynamic matrix from runtime expressions.
   * ADO supports `matrix: $[ dependencies.Job.outputs['step.matrix'] ]`
   * where the previous job outputs a JSON string that becomes the matrix.
   */
  private resolveDynamicMatrix(
    job: RegularJobDefinition,
    pipelineContext: PipelineRunContext,
    prefix: string,
  ): JobStrategy {
    const strategy = { ...job.strategy! };

    if (typeof strategy.matrix !== 'string') {
      return strategy;
    }

    const matrixExpr = strategy.matrix;
    this.log(prefix, chalk.blue(`Resolving dynamic matrix: ${matrixExpr}`));

    // Build expression context with BOTH job-level and stage-level dependencies
    // Job-level: $[dependencies.Job.outputs['step.var']] (same stage)
    // Stage-level: $[stageDependencies.Stage.Job.outputs['step.var']] (cross-stage)
    const variables = this.deps.variableManager.toRecord();
    const jobDependencies = this.deps.outputStore.buildDependencyContext();
    const stageDeps = this.deps.outputStore.buildStageDependencyContext();

    // Detect which context to use based on the expression content
    const useStageDeps = matrixExpr.includes('stageDependencies');
    const exprContext: ExpressionContext = {
      variables,
      parameters: {},
      dependencies: useStageDeps
        ? (stageDeps as unknown as Record<string, { result: string; outputs: Record<string, string> }>)
        : jobDependencies,
      pipeline: {
        'Pipeline.RunId': pipelineContext.runId,
        'Pipeline.RunNumber': String(pipelineContext.runNumber),
        'Pipeline.Name': pipelineContext.pipelineName,
      },
    };

    // Resolve runtime expression
    const resolved = this.deps.expressionEngine.evaluateRuntime(
      matrixExpr,
      exprContext,
    );
    const resolvedStr = typeof resolved === 'string' ? resolved : String(resolved);

    // Parse the JSON result into a matrix record
    let parsedMatrix: Record<string, Record<string, string>>;
    try {
      parsedMatrix = JSON.parse(resolvedStr);
    } catch {
      throw new Error(
        `Dynamic matrix expression resolved to invalid JSON: ${resolvedStr}`,
      );
    }

    // Validate structure: must be Record<string, Record<string, string>>
    if (typeof parsedMatrix !== 'object' || parsedMatrix === null || Array.isArray(parsedMatrix)) {
      throw new Error(
        `Dynamic matrix must resolve to an object, got: ${typeof parsedMatrix}`,
      );
    }

    for (const [configName, configVars] of Object.entries(parsedMatrix)) {
      if (typeof configVars !== 'object' || configVars === null || Array.isArray(configVars)) {
        throw new Error(
          `Dynamic matrix config "${configName}" must be an object of variables`,
        );
      }
      // Coerce all values to strings (matching z.coerce.string() behavior)
      for (const [key, value] of Object.entries(configVars)) {
        parsedMatrix[configName][key] = String(value);
      }
    }

    this.log(
      prefix,
      chalk.blue(`Dynamic matrix resolved: ${Object.keys(parsedMatrix).length} config(s)`),
    );

    strategy.matrix = parsedMatrix;
    return strategy;
  }

  private async runJobInstance(
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
