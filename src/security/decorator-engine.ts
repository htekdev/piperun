// Decorator engine — auto-inject steps from `.pipeline/decorators.yaml`.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type {
  PipelineDefinition,
  StageDefinition,
  JobDefinition,
  StepDefinition,
  RegularJobDefinition,
  DeploymentJobDefinition,
  DeploymentLifecycle,
  LifecycleHook,
} from '../types/pipeline.js';

export interface DecoratorConfig {
  /** Steps injected before each job's steps */
  preJob?: StepDefinition[];
  /** Steps injected after each job's steps */
  postJob?: StepDefinition[];
  /** Steps injected before each step */
  preStep?: StepDefinition[];
  /** Steps injected after each step */
  postStep?: StepDefinition[];
}

/**
 * Load and apply decorator configs that inject steps into pipelines.
 * Decorator files live at `.pipeline/decorators.yaml` in the working directory.
 */
export class DecoratorEngine {
  /** Load decorator config from `.pipeline/decorators.yaml`. Returns null if not found. */
  async loadDecorators(workingDir: string): Promise<DecoratorConfig | null> {
    const filePath = join(workingDir, '.pipeline', 'decorators.yaml');
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const parsed = yaml.load(content);
    if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
      return null;
    }

    const raw = parsed as Record<string, unknown>;
    const config: DecoratorConfig = {};

    if (Array.isArray(raw['preJob'])) {
      config.preJob = raw['preJob'] as StepDefinition[];
    }
    if (Array.isArray(raw['postJob'])) {
      config.postJob = raw['postJob'] as StepDefinition[];
    }
    if (Array.isArray(raw['preStep'])) {
      config.preStep = raw['preStep'] as StepDefinition[];
    }
    if (Array.isArray(raw['postStep'])) {
      config.postStep = raw['postStep'] as StepDefinition[];
    }

    return config;
  }

  /** Apply decorators to a pipeline definition by injecting steps. */
  applyDecorators(
    pipeline: unknown,
    config: DecoratorConfig,
  ): PipelineDefinition {
    const def = structuredClone(pipeline) as PipelineDefinition;

    // Top-level steps shorthand
    if (def.steps) {
      def.steps = this.decorateSteps(def.steps, config);
    }

    // Top-level jobs shorthand
    if (def.jobs) {
      def.jobs = def.jobs.map((job) => this.decorateJob(job, config));
    }

    // Full stages
    if (def.stages) {
      def.stages = def.stages.map((stage) =>
        this.decorateStage(stage, config),
      );
    }

    return def;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private decorateStage(
    stage: StageDefinition,
    config: DecoratorConfig,
  ): StageDefinition {
    if (stage.jobs) {
      return {
        ...stage,
        jobs: stage.jobs.map((job) => this.decorateJob(job, config)),
      };
    }
    return stage;
  }

  private decorateJob(
    job: JobDefinition,
    config: DecoratorConfig,
  ): JobDefinition {
    if ('steps' in job) {
      const regular = job as RegularJobDefinition;
      const decorated = this.decorateSteps(regular.steps, config);
      const withJobDecorators = [
        ...(config.preJob ?? []),
        ...decorated,
        ...(config.postJob ?? []),
      ];
      return { ...regular, steps: withJobDecorators };
    }

    if ('strategy' in job && 'deployment' in job) {
      const deploy = job as DeploymentJobDefinition;
      return {
        ...deploy,
        strategy: this.decorateDeploymentStrategy(deploy.strategy, config),
      };
    }

    // Template reference — pass through
    return job;
  }

  private decorateDeploymentStrategy(
    strategy: DeploymentJobDefinition['strategy'],
    config: DecoratorConfig,
  ): DeploymentJobDefinition['strategy'] {
    const result = structuredClone(strategy);

    const decorateLifecycle = (lc: DeploymentLifecycle): void => {
      const hookKeys: (keyof DeploymentLifecycle)[] = [
        'preDeploy',
        'deploy',
        'routeTraffic',
        'postRouteTraffic',
      ];
      for (const key of hookKeys) {
        const hook = lc[key] as LifecycleHook | undefined;
        if (hook?.steps) {
          hook.steps = [
            ...(config.preJob ?? []),
            ...this.decorateSteps(hook.steps, config),
            ...(config.postJob ?? []),
          ];
        }
      }
      if (lc.on?.success?.steps) {
        lc.on.success.steps = [
          ...(config.preJob ?? []),
          ...this.decorateSteps(lc.on.success.steps, config),
          ...(config.postJob ?? []),
        ];
      }
      if (lc.on?.failure?.steps) {
        lc.on.failure.steps = [
          ...(config.preJob ?? []),
          ...this.decorateSteps(lc.on.failure.steps, config),
          ...(config.postJob ?? []),
        ];
      }
    };

    if (result.runOnce) decorateLifecycle(result.runOnce);
    if (result.rolling) decorateLifecycle(result.rolling);
    if (result.canary) decorateLifecycle(result.canary);

    return result;
  }

  /**
   * Apply preStep/postStep decorators around each individual step.
   * Returns a new array with decorator steps interleaved.
   */
  private decorateSteps(
    steps: StepDefinition[],
    config: DecoratorConfig,
  ): StepDefinition[] {
    if (!config.preStep && !config.postStep) {
      return steps;
    }

    const result: StepDefinition[] = [];
    for (const step of steps) {
      if (config.preStep) {
        result.push(...config.preStep);
      }
      result.push(step);
      if (config.postStep) {
        result.push(...config.postStep);
      }
    }
    return result;
  }
}
