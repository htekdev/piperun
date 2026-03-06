/**
 * Job runner — executes a single job by running its steps sequentially.
 * Manages job-level variable scope, condition evaluation, timeouts,
 * and status tracking.
 */

import chalk from 'chalk';
import type {
  RegularJobDefinition,
  DeploymentJobDefinition,
  StepDefinition,
  StageRunContext,
  PipelineRunContext,
  PipelineStatus,
} from '../types/pipeline.js';
import type { ExpressionContext } from '../types/expressions.js';
import type { ExpressionEngine } from '../compiler/expression-engine.js';
import type { VariableManager } from '../variables/variable-manager.js';
import type { OutputVariableStore } from '../variables/output-variables.js';
import type { SecretMasker } from '../variables/secret-masker.js';
import type { StepResult, StepRunner, StepRunnerOptions } from './step-runner.js';
import type { ConditionEvaluator } from './condition-evaluator.js';

export interface JobRunResult {
  name: string;
  status: PipelineStatus;
  duration: number;
  steps: StepResult[];
}

export interface JobRunnerOptions {
  workingDirectory: string;
  verbose?: boolean;
}

export interface JobRunnerDeps {
  variableManager: VariableManager;
  outputStore: OutputVariableStore;
  expressionEngine: ExpressionEngine;
  conditionEvaluator: ConditionEvaluator;
  secretMasker: SecretMasker;
  stepRunnerFactory: (options: StepRunnerOptions) => StepRunner;
}

export class JobRunner {
  private canceled = false;

  constructor(
    private readonly deps: JobRunnerDeps,
    private readonly options: JobRunnerOptions,
  ) {}

  cancel(): void {
    this.canceled = true;
  }

  async runJob(
    job: RegularJobDefinition | DeploymentJobDefinition,
    stageContext: StageRunContext,
    pipelineContext: PipelineRunContext,
  ): Promise<JobRunResult> {
    const jobName = this.getJobName(job);
    const startTime = Date.now();
    const prefix = chalk.cyan(`[${stageContext.name}/${jobName}]`);

    if (this.canceled) {
      this.log(prefix, chalk.yellow('Skipped (pipeline canceled)'));
      return { name: jobName, status: 'canceled', duration: 0, steps: [] };
    }

    // Enter job scope
    this.deps.variableManager.enterScope('job', jobName);

    try {
      // Load job-level variables
      if (job.variables) {
        this.deps.variableManager.loadVariables(job.variables, 'job');
      }

      // Build expression context for condition evaluation
      const exprContext = this.buildExpressionContext(
        stageContext,
        pipelineContext,
      );

      // Evaluate job condition
      const shouldRun = this.deps.conditionEvaluator.evaluate(
        job.condition,
        exprContext,
        this.deps.conditionEvaluator.getDefaultCondition(),
      );

      if (!shouldRun) {
        this.log(prefix, chalk.yellow('Skipped (condition evaluated to false)'));
        this.deps.outputStore.setJobResult(jobName, 'Skipped');
        return {
          name: jobName,
          status: 'skipped',
          duration: Date.now() - startTime,
          steps: [],
        };
      }

      this.log(prefix, chalk.green('Starting job'));

      // Get steps from the job
      const steps = this.getJobSteps(job);

      if (steps.length === 0) {
        this.log(prefix, chalk.yellow('No steps to execute'));
        this.deps.outputStore.setJobResult(jobName, 'Succeeded');
        return {
          name: jobName,
          status: 'succeeded',
          duration: Date.now() - startTime,
          steps: [],
        };
      }

      // Create step runner
      const environment = {
        ...this.deps.variableManager.toEnvironment(),
      };

      const stepRunner = this.deps.stepRunnerFactory({
        workingDirectory: this.options.workingDirectory,
        environment,
        timeoutMs: job.timeoutInMinutes
          ? job.timeoutInMinutes * 60 * 1000
          : undefined,
        secretMasker: this.deps.secretMasker,
        onOutput: (line: string, stream: 'stdout' | 'stderr') => {
          if (this.options.verbose) {
            const masked = this.deps.secretMasker.mask(line);
            const streamPrefix = stream === 'stderr' ? chalk.red('ERR') : 'OUT';
            console.log(`${prefix} ${streamPrefix}: ${masked}`);
          }
        },
        onLoggingCommand: (
          command: string,
          properties: Record<string, string>,
          value: string,
        ) => {
          this.handleLoggingCommand(
            jobName,
            command,
            properties,
            value,
          );
        },
      });

      // Execute steps sequentially
      const stepResults: StepResult[] = [];
      let jobStatus: PipelineStatus = 'succeeded';
      let jobTimedOut = false;

      const jobTimeoutMs = job.timeoutInMinutes
        ? job.timeoutInMinutes * 60 * 1000
        : undefined;
      const jobStartTime = Date.now();

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepName = this.getStepName(step, i);

        if (this.canceled) {
          this.log(prefix, chalk.yellow(`Step '${stepName}': Skipped (canceled)`));
          stepResults.push(this.createSkippedStepResult());
          continue;
        }

        // Check job-level timeout
        if (jobTimeoutMs && Date.now() - jobStartTime > jobTimeoutMs) {
          this.log(prefix, chalk.red(`Job timed out after ${job.timeoutInMinutes} minutes`));
          jobTimedOut = true;
          jobStatus = 'failed';
          stepResults.push(this.createSkippedStepResult());
          continue;
        }

        // Build step-level expression context (with updated statuses)
        const stepExprContext = this.buildExpressionContext(
          stageContext,
          pipelineContext,
          jobStatus,
        );

        // Evaluate step condition
        const stepCondition = this.getStepCondition(step);
        const stepEnabled = this.isStepEnabled(step);

        if (!stepEnabled) {
          this.log(prefix, chalk.dim(`Step '${stepName}': Disabled`));
          stepResults.push(this.createSkippedStepResult());
          continue;
        }

        const stepShouldRun = this.deps.conditionEvaluator.evaluate(
          stepCondition,
          stepExprContext,
          this.deps.conditionEvaluator.getDefaultCondition(),
        );

        if (!stepShouldRun) {
          this.log(prefix, chalk.dim(`Step '${stepName}': Skipped (condition)`));
          stepResults.push(this.createSkippedStepResult());
          continue;
        }

        if (this.options.verbose) {
          this.log(prefix, chalk.white(`Step '${stepName}': Running`));
        }

        const stepResult = await stepRunner.executeStep(step, stepName);
        stepResults.push(stepResult);

        // Process step outputs
        if (stepResult.outputs) {
          for (const [key, value] of Object.entries(stepResult.outputs)) {
            this.deps.outputStore.setOutput(jobName, stepName, key, value);
          }
        }

        // Determine impact on job status
        if (stepResult.status === 'failed') {
          const continueOnError = this.getStepContinueOnError(step);
          if (continueOnError) {
            this.log(
              prefix,
              chalk.yellow(
                `Step '${stepName}': Failed (continueOnError=true, proceeding)`,
              ),
            );
            if (jobStatus === 'succeeded') {
              jobStatus = 'succeededWithIssues';
            }
          } else {
            this.log(
              prefix,
              chalk.red(`Step '${stepName}': Failed (exit code ${stepResult.exitCode})`),
            );
            jobStatus = 'failed';
            // Skip remaining steps (unless they have always() conditions)
            for (let j = i + 1; j < steps.length; j++) {
              const remainingStep = steps[j];
              const remainingStepName = this.getStepName(remainingStep, j);
              const remainingStepCondition = this.getStepCondition(remainingStep);

              // Only run remaining steps if their condition explicitly allows it
              // (e.g., always() or failed() conditions)
              const remainingExprContext = this.buildExpressionContext(
                stageContext,
                pipelineContext,
                jobStatus,
              );

              const remainingEnabled = this.isStepEnabled(remainingStep);
              if (!remainingEnabled) {
                stepResults.push(this.createSkippedStepResult());
                continue;
              }

              const remainingShouldRun = this.deps.conditionEvaluator.evaluate(
                remainingStepCondition,
                remainingExprContext,
                this.deps.conditionEvaluator.getDefaultCondition(),
              );

              if (remainingShouldRun && remainingStepCondition !== undefined) {
                // This step has an explicit condition that still evaluates true
                if (this.options.verbose) {
                  this.log(prefix, chalk.white(`Step '${remainingStepName}': Running (explicit condition)`));
                }
                const remainingResult = await stepRunner.executeStep(
                  remainingStep,
                  remainingStepName,
                );
                stepResults.push(remainingResult);

                if (remainingResult.outputs) {
                  for (const [key, value] of Object.entries(remainingResult.outputs)) {
                    this.deps.outputStore.setOutput(jobName, remainingStepName, key, value);
                  }
                }
              } else {
                this.log(
                  prefix,
                  chalk.dim(`Step '${remainingStepName}': Skipped (previous step failed)`),
                );
                stepResults.push(this.createSkippedStepResult());
              }
            }
            break;
          }
        } else if (stepResult.status === 'succeeded') {
          if (this.options.verbose) {
            this.log(prefix, chalk.green(`Step '${stepName}': Succeeded`));
          }
        }
      }

      // If the job timed out, status is failed
      if (jobTimedOut) {
        jobStatus = 'failed';
      }

      // Record job result
      const resultLabel = this.statusToResultLabel(jobStatus);
      this.deps.outputStore.setJobResult(jobName, resultLabel);

      const duration = Date.now() - startTime;
      const statusColor = jobStatus === 'succeeded'
        ? chalk.green
        : jobStatus === 'failed'
          ? chalk.red
          : chalk.yellow;
      this.log(
        prefix,
        statusColor(`Completed with status: ${jobStatus} (${(duration / 1000).toFixed(1)}s)`),
      );

      return { name: jobName, status: jobStatus, duration, steps: stepResults };
    } finally {
      this.deps.variableManager.exitScope();
    }
  }

  private getJobName(
    job: RegularJobDefinition | DeploymentJobDefinition,
  ): string {
    if ('job' in job) return job.job;
    if ('deployment' in job) return job.deployment;
    return '__unknown';
  }

  private getJobSteps(
    job: RegularJobDefinition | DeploymentJobDefinition,
  ): StepDefinition[] {
    if ('steps' in job) {
      return job.steps;
    }
    // Deployment jobs: extract steps from the strategy lifecycle
    if ('strategy' in job && job.strategy) {
      const strategy = job.strategy;
      if (strategy.runOnce?.deploy?.steps) {
        return strategy.runOnce.deploy.steps;
      }
      if (strategy.rolling?.deploy?.steps) {
        return strategy.rolling.deploy.steps;
      }
      if (strategy.canary?.deploy?.steps) {
        return strategy.canary.deploy.steps;
      }
    }
    return [];
  }

  private getStepName(step: StepDefinition, index: number): string {
    if ('name' in step && step.name) return step.name;
    if ('displayName' in step && step.displayName) return step.displayName;
    if ('pwsh' in step) return `pwsh_${index}`;
    if ('node' in step) return `node_${index}`;
    if ('python' in step) return `python_${index}`;
    if ('task' in step) return `task_${index}`;
    return `step_${index}`;
  }

  private getStepCondition(step: StepDefinition): string | undefined {
    if ('condition' in step) return step.condition;
    return undefined;
  }

  private getStepContinueOnError(step: StepDefinition): boolean {
    if ('continueOnError' in step) return step.continueOnError ?? false;
    return false;
  }

  private isStepEnabled(step: StepDefinition): boolean {
    if ('enabled' in step) return step.enabled !== false;
    return true;
  }

  private buildExpressionContext(
    stageContext: StageRunContext,
    pipelineContext: PipelineRunContext,
    currentJobStatus?: PipelineStatus,
  ): ExpressionContext {
    const variables = this.deps.variableManager.toRecord();
    const dependencies = this.deps.outputStore.buildDependencyContext();

    return {
      variables,
      parameters: {},
      dependencies,
      pipeline: {
        'Pipeline.RunId': pipelineContext.runId,
        'Pipeline.RunNumber': String(pipelineContext.runNumber),
        'Pipeline.Name': pipelineContext.pipelineName,
        ...(currentJobStatus ? { 'Job.Status': currentJobStatus } : {}),
      },
    };
  }

  private handleLoggingCommand(
    jobName: string,
    command: string,
    properties: Record<string, string>,
    value: string,
  ): void {
    if (command === 'setvariable') {
      const varName = properties['variable'];
      if (!varName) return;

      const isOutput = properties['isOutput'] === 'true';
      const isSecret = properties['isSecret'] === 'true';

      if (isOutput) {
        // Record as job output for downstream dependencies
        const stepName = properties['step'] ?? '__current';
        this.deps.outputStore.setOutput(jobName, stepName, varName, value, isSecret);
      }

      if (isSecret) {
        this.deps.secretMasker.addSecret(value);
      }

      // Set variable in current scope
      this.deps.variableManager.set(varName, value, {
        isSecret,
        isOutput,
        source: 'output',
      });
    }
  }

  private createSkippedStepResult(): StepResult {
    return {
      status: 'skipped',
      exitCode: 0,
      stdout: '',
      stderr: '',
      duration: 0,
      outputs: {},
      retryCount: 0,
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
