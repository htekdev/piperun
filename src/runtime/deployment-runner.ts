/**
 * Deployment runner — executes deployment jobs with lifecycle hooks
 * for runOnce, rolling, and canary strategies.
 */

import chalk from 'chalk';
import type {
  DeploymentJobDefinition,
  DeploymentLifecycle,
  DeploymentStrategy,
  CanaryStrategy,
  RollingStrategy,
  LifecycleHook,
  PipelineRunContext,
  PipelineStatus,
  EnvironmentReference,
  StepDefinition,
} from '../types/pipeline.js';
import type { ExpressionEngine } from '../compiler/expression-engine.js';
import type { VariableManager } from '../variables/variable-manager.js';
import type { OutputVariableStore } from '../variables/output-variables.js';
import type { SecretMasker } from '../variables/secret-masker.js';
import type { ConditionEvaluator } from './condition-evaluator.js';
import { StepRunner, type StepResult, type StepRunnerOptions } from './step-runner.js';

// ─── Public types ───────────────────────────────────────────────────────────

export interface DeploymentRunResult {
  name: string;
  status: PipelineStatus;
  duration: number;
  environment: string;
  strategy: string;
  hooks: HookRunResult[];
}

export interface HookRunResult {
  name: string;
  status: PipelineStatus;
  steps: StepResult[];
  duration: number;
}

export interface DeploymentRunnerOptions {
  workingDirectory: string;
  verbose?: boolean;
}

export interface DeploymentRunnerDeps {
  variableManager: VariableManager;
  outputStore: OutputVariableStore;
  expressionEngine: ExpressionEngine;
  conditionEvaluator: ConditionEvaluator;
  secretMasker: SecretMasker;
}

// ─── Hook execution order ───────────────────────────────────────────────────

const MAIN_HOOK_NAMES = [
  'preDeploy',
  'deploy',
  'routeTraffic',
  'postRouteTraffic',
] as const;

type MainHookName = (typeof MAIN_HOOK_NAMES)[number];

// ─── DeploymentRunner class ─────────────────────────────────────────────────

export class DeploymentRunner {
  constructor(
    private readonly deps: DeploymentRunnerDeps,
    private readonly options: DeploymentRunnerOptions,
  ) {}

  /**
   * Run a deployment job — dispatches to the appropriate strategy handler.
   */
  async runDeployment(
    job: DeploymentJobDefinition,
    _pipelineContext: PipelineRunContext,
  ): Promise<DeploymentRunResult> {
    const deploymentName = job.deployment;
    const environment = this.resolveEnvironmentName(job.environment);
    const strategy = job.strategy;
    const prefix = chalk.blue(`[deploy:${deploymentName}]`);

    this.log(prefix, chalk.green(`Deploying to environment: ${environment}`));

    // Set environment variable for steps
    this.deps.variableManager.enterScope('job', deploymentName);

    try {
      this.deps.variableManager.set('Environment.Name', environment, {
        source: 'system',
      });

      if (job.variables) {
        this.deps.variableManager.loadVariables(job.variables, 'job');
      }

      if (strategy.runOnce) {
        return this.runRunOnce(strategy.runOnce, environment, deploymentName);
      }

      if (strategy.rolling) {
        return this.runRolling(strategy.rolling, environment, deploymentName);
      }

      if (strategy.canary) {
        return this.runCanary(strategy.canary, environment, deploymentName);
      }

      // No strategy specified
      this.log(prefix, chalk.yellow('No deployment strategy specified'));
      return {
        name: deploymentName,
        status: 'succeeded',
        duration: 0,
        environment,
        strategy: 'none',
        hooks: [],
      };
    } finally {
      this.deps.variableManager.exitScope();
    }
  }

  /**
   * runOnce strategy — execute lifecycle hooks once (standard deployment).
   */
  private async runRunOnce(
    lifecycle: DeploymentLifecycle,
    environment: string,
    deploymentName: string,
  ): Promise<DeploymentRunResult> {
    const startTime = Date.now();
    const prefix = chalk.blue(`[deploy:${deploymentName}:runOnce]`);

    this.log(prefix, chalk.cyan('Running runOnce strategy'));
    this.deps.variableManager.set('Strategy.Name', 'runOnce', {
      source: 'system',
    });

    const { hooks, mainSucceeded } = await this.runLifecycleHooks(
      lifecycle,
      deploymentName,
    );

    return {
      name: deploymentName,
      status: mainSucceeded ? 'succeeded' : 'failed',
      duration: Date.now() - startTime,
      environment,
      strategy: 'runOnce',
      hooks,
    };
  }

  /**
   * rolling strategy — execute in batches controlled by maxParallel.
   * For now, runs all hooks once (full rolling logic requires multiple targets).
   */
  private async runRolling(
    lifecycle: RollingStrategy,
    environment: string,
    deploymentName: string,
  ): Promise<DeploymentRunResult> {
    const startTime = Date.now();
    const prefix = chalk.blue(`[deploy:${deploymentName}:rolling]`);
    const maxParallel = lifecycle.maxParallel ?? 1;

    this.log(
      prefix,
      chalk.cyan(`Running rolling strategy (maxParallel: ${maxParallel})`),
    );
    this.deps.variableManager.set('Strategy.Name', 'rolling', {
      source: 'system',
    });

    const { hooks, mainSucceeded } = await this.runLifecycleHooks(
      lifecycle,
      deploymentName,
    );

    return {
      name: deploymentName,
      status: mainSucceeded ? 'succeeded' : 'failed',
      duration: Date.now() - startTime,
      environment,
      strategy: 'rolling',
      hooks,
    };
  }

  /**
   * canary strategy — execute in incremental phases defined by increments array.
   * Sets Strategy.CycleName variable to the increment value for each phase.
   * Runs hooks once per increment.
   */
  private async runCanary(
    lifecycle: CanaryStrategy,
    environment: string,
    deploymentName: string,
  ): Promise<DeploymentRunResult> {
    const startTime = Date.now();
    const prefix = chalk.blue(`[deploy:${deploymentName}:canary]`);
    const increments = lifecycle.increments ?? [100];

    this.log(
      prefix,
      chalk.cyan(`Running canary strategy (increments: ${increments.join(', ')})`),
    );
    this.deps.variableManager.set('Strategy.Name', 'canary', {
      source: 'system',
    });

    const allHooks: HookRunResult[] = [];
    let overallSuccess = true;

    for (const increment of increments) {
      this.log(prefix, chalk.cyan(`Canary increment: ${increment}%`));
      this.deps.variableManager.set('Strategy.CycleName', String(increment), {
        source: 'system',
      });

      const { hooks, mainSucceeded } = await this.runLifecycleHooks(
        lifecycle,
        deploymentName,
      );
      allHooks.push(...hooks);

      if (!mainSucceeded) {
        overallSuccess = false;
        break;
      }
    }

    return {
      name: deploymentName,
      status: overallSuccess ? 'succeeded' : 'failed',
      duration: Date.now() - startTime,
      environment,
      strategy: 'canary',
      hooks: allHooks,
    };
  }

  /**
   * Run lifecycle hooks in the standard order:
   * 1. preDeploy → deploy → routeTraffic → postRouteTraffic
   * 2. If all above succeeded: on.success
   * 3. If any above failed: on.failure
   *
   * Returns hook results and whether the main hooks succeeded.
   */
  private async runLifecycleHooks(
    lifecycle: DeploymentLifecycle,
    deploymentName: string,
  ): Promise<{ hooks: HookRunResult[]; mainSucceeded: boolean }> {
    const hooks: HookRunResult[] = [];
    let mainSucceeded = true;
    const prefix = chalk.blue(`[deploy:${deploymentName}]`);

    // Execute main hooks in order
    for (const hookName of MAIN_HOOK_NAMES) {
      const hook = lifecycle[hookName];
      if (!hook) {
        continue;
      }

      this.log(prefix, chalk.white(`Running hook: ${hookName}`));
      const hookResult = await this.runSingleHook(hookName, hook, deploymentName);
      hooks.push(hookResult);

      if (hookResult.status === 'failed') {
        mainSucceeded = false;
        this.log(prefix, chalk.red(`Hook '${hookName}' failed — skipping remaining main hooks`));
        break;
      }
    }

    // Execute completion hooks
    if (mainSucceeded && lifecycle.on?.success) {
      this.log(prefix, chalk.green('Running on.success hook'));
      const successResult = await this.runSingleHook(
        'on.success',
        lifecycle.on.success,
        deploymentName,
      );
      hooks.push(successResult);
    } else if (!mainSucceeded && lifecycle.on?.failure) {
      this.log(prefix, chalk.red('Running on.failure hook'));
      const failureResult = await this.runSingleHook(
        'on.failure',
        lifecycle.on.failure,
        deploymentName,
      );
      hooks.push(failureResult);
    }

    return { hooks, mainSucceeded };
  }

  /**
   * Execute a single lifecycle hook by running its steps sequentially.
   */
  private async runSingleHook(
    hookName: string,
    hook: LifecycleHook,
    deploymentName: string,
  ): Promise<HookRunResult> {
    const startTime = Date.now();
    const steps = hook.steps;

    if (!steps || steps.length === 0) {
      return {
        name: hookName,
        status: 'succeeded',
        steps: [],
        duration: 0,
      };
    }

    const environment = this.deps.variableManager.toEnvironment();
    const stepRunner = new StepRunner({
      workingDirectory: this.options.workingDirectory,
      environment,
      secretMasker: this.deps.secretMasker,
      onOutput: (line: string, stream: 'stdout' | 'stderr') => {
        if (this.options.verbose) {
          const masked = this.deps.secretMasker.mask(line);
          const streamPrefix = stream === 'stderr' ? chalk.red('ERR') : 'OUT';
          console.log(
            `${chalk.blue(`[deploy:${deploymentName}:${hookName}]`)} ${streamPrefix}: ${masked}`,
          );
        }
      },
    });

    const stepResults: StepResult[] = [];
    let hookStatus: PipelineStatus = 'succeeded';

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepName = this.getStepName(step, i);
      const result = await stepRunner.executeStep(step, stepName);
      stepResults.push(result);

      if (result.status === 'failed') {
        hookStatus = 'failed';
        break;
      }
    }

    return {
      name: hookName,
      status: hookStatus,
      steps: stepResults,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Resolve the environment name from a string or EnvironmentReference.
   */
  private resolveEnvironmentName(
    env: string | EnvironmentReference,
  ): string {
    if (typeof env === 'string') {
      return env;
    }
    return env.name;
  }

  /**
   * Get a display name for a step.
   */
  private getStepName(step: StepDefinition, index: number): string {
    if ('name' in step && step.name) return step.name;
    if ('displayName' in step && step.displayName) return step.displayName;
    if ('pwsh' in step) return `pwsh_${index}`;
    if ('node' in step) return `node_${index}`;
    if ('python' in step) return `python_${index}`;
    if ('task' in step) return `task_${index}`;
    return `step_${index}`;
  }

  private log(prefix: string, message: string): void {
    console.log(`${prefix} ${message}`);
  }
}
