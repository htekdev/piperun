// Extends policy enforcement — controls what's allowed in pipelines that use `extends`.

import type {
  PipelineDefinition,
  StageDefinition,
  JobDefinition,
  StepDefinition,
  RegularJobDefinition,
  DeploymentJobDefinition,
} from '../types/pipeline.js';

export interface ExtendsPolicy {
  /** List of allowed task names (glob patterns supported) */
  allowedTasks?: string[];
  /** List of allowed step types */
  allowedStepTypes?: ('pwsh' | 'node' | 'python' | 'task')[];
  /** Whether to allow custom scripts at all */
  allowScripts?: boolean;
  /** Maximum number of pipeline parameters allowed */
  maxParameters?: number;
}

export interface ValidationResult {
  valid: boolean;
  violations: string[];
}

export interface StepCheckResult {
  allowed: boolean;
  reason?: string;
}

const SCRIPT_STEP_TYPES = new Set(['pwsh', 'node', 'python']);

/**
 * Enforce what's allowed in a pipeline that uses `extends`.
 * This is a key security feature — templates can restrict
 * what child pipelines are permitted to do.
 */
export class ExtendsEnforcer {
  constructor(private policy: ExtendsPolicy) {}

  /** Validate an entire pipeline definition against the extends policy. */
  validate(pipeline: unknown): ValidationResult {
    const violations: string[] = [];
    const def = pipeline as PipelineDefinition;

    // Check parameter count
    if (
      this.policy.maxParameters !== undefined &&
      def.parameters &&
      def.parameters.length > this.policy.maxParameters
    ) {
      violations.push(
        `Pipeline has ${def.parameters.length} parameters but the policy allows at most ${this.policy.maxParameters}`,
      );
    }

    // Collect every step in the pipeline
    const allSteps = this.collectAllSteps(def);

    for (const step of allSteps) {
      const check = this.isStepAllowed(step);
      if (!check.allowed) {
        violations.push(check.reason!);
      }
    }

    return { valid: violations.length === 0, violations };
  }

  /** Check if a single step is allowed under the current policy. */
  isStepAllowed(step: unknown): StepCheckResult {
    const s = step as StepDefinition;

    // Template references are always allowed (they get resolved separately)
    if ('template' in s) {
      return { allowed: true };
    }

    const stepType = this.getStepType(s);
    if (!stepType) {
      return { allowed: true };
    }

    // Check allowScripts — if false, reject script step types
    if (this.policy.allowScripts === false && SCRIPT_STEP_TYPES.has(stepType)) {
      return {
        allowed: false,
        reason: `Step type '${stepType}' is not allowed: scripts are disabled by policy`,
      };
    }

    // Check allowedStepTypes
    if (this.policy.allowedStepTypes) {
      const allowed = this.policy.allowedStepTypes as string[];
      if (!allowed.includes(stepType)) {
        return {
          allowed: false,
          reason: `Step type '${stepType}' is not in the allowed list: [${this.policy.allowedStepTypes.join(', ')}]`,
        };
      }
    }

    // Check allowedTasks for task steps
    if (stepType === 'task') {
      const taskStep = s as { task: string };
      if (!this.isTaskAllowed(taskStep.task)) {
        return {
          allowed: false,
          reason: `Task '${taskStep.task}' is not in the allowed task list`,
        };
      }
    }

    return { allowed: true };
  }

  /** Check if a task name matches the allowed task list (glob patterns supported). */
  isTaskAllowed(taskName: string): boolean {
    if (!this.policy.allowedTasks) {
      return true;
    }

    return this.policy.allowedTasks.some((pattern) =>
      this.matchGlob(pattern, taskName),
    );
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /** Recursively collect every step from stages → jobs → steps. */
  private collectAllSteps(def: PipelineDefinition): StepDefinition[] {
    const steps: StepDefinition[] = [];

    // Top-level steps shorthand
    if (def.steps) {
      steps.push(...def.steps);
    }

    // Top-level jobs shorthand
    if (def.jobs) {
      for (const job of def.jobs) {
        steps.push(...this.stepsFromJob(job));
      }
    }

    // Full stages
    if (def.stages) {
      for (const stage of def.stages) {
        steps.push(...this.stepsFromStage(stage));
      }
    }

    return steps;
  }

  private stepsFromStage(stage: StageDefinition): StepDefinition[] {
    const steps: StepDefinition[] = [];
    if (stage.jobs) {
      for (const job of stage.jobs) {
        steps.push(...this.stepsFromJob(job));
      }
    }
    return steps;
  }

  private stepsFromJob(job: JobDefinition): StepDefinition[] {
    const steps: StepDefinition[] = [];

    if ('steps' in job) {
      // RegularJobDefinition
      const regular = job as RegularJobDefinition;
      steps.push(...regular.steps);
    } else if ('strategy' in job && 'deployment' in job) {
      // DeploymentJobDefinition — walk lifecycle hooks
      const deploy = job as DeploymentJobDefinition;
      steps.push(...this.stepsFromDeploymentStrategy(deploy));
    }
    // JobTemplateReference is skipped — templates are resolved separately

    return steps;
  }

  private stepsFromDeploymentStrategy(
    deploy: DeploymentJobDefinition,
  ): StepDefinition[] {
    const steps: StepDefinition[] = [];
    const strategy = deploy.strategy;

    const lifecycle = strategy.runOnce ?? strategy.rolling ?? strategy.canary;
    if (!lifecycle) {
      return steps;
    }

    const hooks = [
      lifecycle.preDeploy,
      lifecycle.deploy,
      lifecycle.routeTraffic,
      lifecycle.postRouteTraffic,
      lifecycle.on?.success,
      lifecycle.on?.failure,
    ];

    for (const hook of hooks) {
      if (hook?.steps) {
        steps.push(...hook.steps);
      }
    }

    return steps;
  }

  /** Determine the step type from a StepDefinition union member. */
  private getStepType(
    step: StepDefinition,
  ): 'pwsh' | 'node' | 'python' | 'task' | null {
    if ('pwsh' in step) return 'pwsh';
    if ('node' in step) return 'node';
    if ('python' in step) return 'python';
    if ('task' in step) return 'task';
    return null;
  }

  /**
   * Simple glob matcher supporting `*` and `**` in task name patterns.
   * Converts glob to regex.
   */
  private matchGlob(pattern: string, value: string): boolean {
    // Escape regex special chars except * and ?
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Convert glob wildcards to regex
    const regexStr = escaped
      .replace(/\*\*/g, '@@DOUBLESTAR@@')
      .replace(/\*/g, '[^@]*')
      .replace(/@@DOUBLESTAR@@/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${regexStr}$`, 'i');
    return regex.test(value);
  }
}
