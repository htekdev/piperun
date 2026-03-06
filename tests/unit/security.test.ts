import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtendsEnforcer } from '../../src/security/extends-enforcer.js';
import type { ExtendsPolicy } from '../../src/security/extends-enforcer.js';
import { DecoratorEngine } from '../../src/security/decorator-engine.js';
import { VariableGuard } from '../../src/security/variable-guard.js';
import type { PipelineDefinition } from '../../src/types/pipeline.js';
import type { SettableVariablesConfig } from '../../src/types/variables.js';

// ─── ExtendsEnforcer ────────────────────────────────────────────────────────────

describe('ExtendsEnforcer', () => {
  describe('allowed tasks validation', () => {
    it('allows tasks matching the allowed list', () => {
      const policy: ExtendsPolicy = { allowedTasks: ['Build@*', 'Test@1'] };
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isTaskAllowed('Build@1')).toBe(true);
      expect(enforcer.isTaskAllowed('Build@2')).toBe(true);
      expect(enforcer.isTaskAllowed('Test@1')).toBe(true);
    });

    it('rejects tasks not matching the allowed list', () => {
      const policy: ExtendsPolicy = { allowedTasks: ['Build@1'] };
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isTaskAllowed('Deploy@1')).toBe(false);
      expect(enforcer.isTaskAllowed('Hack@1')).toBe(false);
    });

    it('allows all tasks when allowedTasks is not set', () => {
      const policy: ExtendsPolicy = {};
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isTaskAllowed('AnyTask@1')).toBe(true);
    });

    it('validates pipeline-level task steps against allowed list', () => {
      const policy: ExtendsPolicy = { allowedTasks: ['Allowed@*'] };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        steps: [
          { task: 'Allowed@1', inputs: {} },
          { task: 'Forbidden@1', inputs: {} },
        ],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain('Forbidden@1');
    });
  });

  describe('allowed step types validation', () => {
    it('allows steps matching the allowed types', () => {
      const policy: ExtendsPolicy = { allowedStepTypes: ['pwsh', 'task'] };
      const enforcer = new ExtendsEnforcer(policy);

      const pwshCheck = enforcer.isStepAllowed({ pwsh: 'echo hi' });
      expect(pwshCheck.allowed).toBe(true);

      const taskCheck = enforcer.isStepAllowed({ task: 'Build@1' });
      expect(taskCheck.allowed).toBe(true);
    });

    it('rejects steps not in the allowed types', () => {
      const policy: ExtendsPolicy = { allowedStepTypes: ['task'] };
      const enforcer = new ExtendsEnforcer(policy);

      const nodeCheck = enforcer.isStepAllowed({ node: 'console.log("hi")' });
      expect(nodeCheck.allowed).toBe(false);
      expect(nodeCheck.reason).toContain('node');
    });

    it('validates a full pipeline with stages and jobs', () => {
      const policy: ExtendsPolicy = { allowedStepTypes: ['task'] };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        stages: [
          {
            stage: 'Build',
            jobs: [
              {
                job: 'BuildJob',
                steps: [
                  { task: 'Build@1' },
                  { pwsh: 'echo forbidden' },
                ],
              },
            ],
          },
        ],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
      expect(result.violations[0]).toContain('pwsh');
    });
  });

  describe('allowScripts enforcement', () => {
    it('rejects all script steps when allowScripts=false', () => {
      const policy: ExtendsPolicy = { allowScripts: false };
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isStepAllowed({ pwsh: 'echo hi' }).allowed).toBe(false);
      expect(enforcer.isStepAllowed({ node: 'console.log()' }).allowed).toBe(false);
      expect(enforcer.isStepAllowed({ python: 'print()' }).allowed).toBe(false);
    });

    it('allows task steps when allowScripts=false', () => {
      const policy: ExtendsPolicy = { allowScripts: false };
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isStepAllowed({ task: 'Build@1' }).allowed).toBe(true);
    });

    it('allows script steps when allowScripts is not set', () => {
      const policy: ExtendsPolicy = {};
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isStepAllowed({ pwsh: 'echo hi' }).allowed).toBe(true);
    });
  });

  describe('maxParameters enforcement', () => {
    it('rejects pipelines with too many parameters', () => {
      const policy: ExtendsPolicy = { maxParameters: 2 };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        parameters: [
          { name: 'p1', type: 'string' },
          { name: 'p2', type: 'string' },
          { name: 'p3', type: 'string' },
        ],
        steps: [],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toContain('3 parameters');
      expect(result.violations[0]).toContain('at most 2');
    });

    it('allows pipelines within the parameter limit', () => {
      const policy: ExtendsPolicy = { maxParameters: 3 };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        parameters: [
          { name: 'p1', type: 'string' },
          { name: 'p2', type: 'string' },
        ],
        steps: [],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(true);
    });

    it('allows any parameters when maxParameters is not set', () => {
      const policy: ExtendsPolicy = {};
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        parameters: Array.from({ length: 100 }, (_, i) => ({
          name: `p${i}`,
          type: 'string' as const,
        })),
        steps: [],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(true);
    });
  });

  describe('template step references', () => {
    it('allows template step references regardless of policy', () => {
      const policy: ExtendsPolicy = { allowScripts: false, allowedStepTypes: ['task'] };
      const enforcer = new ExtendsEnforcer(policy);

      const check = enforcer.isStepAllowed({ template: 'steps/build.yaml' });
      expect(check.allowed).toBe(true);
    });
  });

  describe('step type detection', () => {
    it('detects node step type', () => {
      const policy: ExtendsPolicy = { allowedStepTypes: ['node'] };
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isStepAllowed({ node: 'console.log()' }).allowed).toBe(true);
    });

    it('detects python step type', () => {
      const policy: ExtendsPolicy = { allowedStepTypes: ['python'] };
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isStepAllowed({ python: 'print()' }).allowed).toBe(true);
    });

    it('returns allowed for unknown step type (no known key)', () => {
      const policy: ExtendsPolicy = { allowedStepTypes: ['task'] };
      const enforcer = new ExtendsEnforcer(policy);

      const check = enforcer.isStepAllowed({ unknown: 'something' } as unknown);
      expect(check.allowed).toBe(true);
    });
  });

  describe('pipeline structure validation', () => {
    it('validates top-level steps', () => {
      const policy: ExtendsPolicy = { allowScripts: false };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        steps: [
          { pwsh: 'echo forbidden' },
        ],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(false);
    });

    it('validates top-level jobs', () => {
      const policy: ExtendsPolicy = { allowedStepTypes: ['task'] };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        jobs: [
          {
            job: 'Build',
            steps: [{ node: 'console.log("forbidden")' }],
          },
        ],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(false);
    });

    it('validates deployment job lifecycle hooks', () => {
      const policy: ExtendsPolicy = { allowScripts: false };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        jobs: [
          {
            deployment: 'web',
            environment: 'prod',
            strategy: {
              runOnce: {
                deploy: {
                  steps: [{ pwsh: 'echo deploy' }],
                },
              },
            },
          } as unknown as import('../../src/types/pipeline.js').JobDefinition,
        ],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(false);
    });

    it('validates deployment job on.success/failure hooks', () => {
      const policy: ExtendsPolicy = { allowScripts: false };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        jobs: [
          {
            deployment: 'web',
            environment: 'prod',
            strategy: {
              runOnce: {
                deploy: {
                  steps: [{ task: 'Deploy@1' }],
                },
                on: {
                  success: {
                    steps: [{ pwsh: 'echo success' }],
                  },
                },
              },
            },
          } as unknown as import('../../src/types/pipeline.js').JobDefinition,
        ],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(false);
    });

    it('handles deployment with no lifecycle strategy', () => {
      const policy: ExtendsPolicy = { allowScripts: false };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        jobs: [
          {
            deployment: 'web',
            environment: 'prod',
            strategy: {},
          } as unknown as import('../../src/types/pipeline.js').JobDefinition,
        ],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(true);
    });

    it('handles stages without jobs', () => {
      const policy: ExtendsPolicy = {};
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        stages: [
          { stage: 'EmptyStage' },
        ],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(true);
    });

    it('validates pipeline with no steps, jobs, or stages', () => {
      const policy: ExtendsPolicy = {};
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {};

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(true);
    });

    it('validates pipeline without parameters set (maxParameters check skipped)', () => {
      const policy: ExtendsPolicy = { maxParameters: 2 };
      const enforcer = new ExtendsEnforcer(policy);

      const pipeline: PipelineDefinition = {
        steps: [{ task: 'Build@1' }],
      };

      const result = enforcer.validate(pipeline);
      expect(result.valid).toBe(true);
    });
  });

  describe('glob pattern matching', () => {
    it('matches ** glob patterns', () => {
      const policy: ExtendsPolicy = { allowedTasks: ['Npm**'] };
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isTaskAllowed('NpmBuild@1')).toBe(true);
      expect(enforcer.isTaskAllowed('NpmInstall@2')).toBe(true);
    });

    it('matches ? glob patterns', () => {
      const policy: ExtendsPolicy = { allowedTasks: ['Build@?'] };
      const enforcer = new ExtendsEnforcer(policy);

      expect(enforcer.isTaskAllowed('Build@1')).toBe(true);
      expect(enforcer.isTaskAllowed('Build@2')).toBe(true);
      expect(enforcer.isTaskAllowed('Build@10')).toBe(false);
    });
  });
});

// ─── DecoratorEngine ────────────────────────────────────────────────────────────

describe('DecoratorEngine', () => {
  let tmpDir: string;
  let engine: DecoratorEngine;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'piperun-decorator-'));
    engine = new DecoratorEngine();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadDecorators', () => {
    it('loads decorators from .pipeline/decorators.yaml', async () => {
      const pipelineDir = join(tmpDir, '.pipeline');
      await mkdir(pipelineDir, { recursive: true });
      await writeFile(
        join(pipelineDir, 'decorators.yaml'),
        `
preJob:
  - pwsh: echo "Starting job..."
    displayName: "Decorator: Job Start"
postJob:
  - pwsh: echo "Job complete."
    displayName: "Decorator: Job End"
`,
      );

      const config = await engine.loadDecorators(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.preJob).toHaveLength(1);
      expect(config!.postJob).toHaveLength(1);
      expect((config!.preJob![0] as { pwsh: string }).pwsh).toBe('echo "Starting job..."');
    });

    it('returns null when decorator file does not exist', async () => {
      const config = await engine.loadDecorators(tmpDir);
      expect(config).toBeNull();
    });

    it('returns null for invalid YAML', async () => {
      const pipelineDir = join(tmpDir, '.pipeline');
      await mkdir(pipelineDir, { recursive: true });
      await writeFile(join(pipelineDir, 'decorators.yaml'), 'null');

      const config = await engine.loadDecorators(tmpDir);
      expect(config).toBeNull();
    });
  });

  describe('applyDecorators', () => {
    it('injects preJob and postJob steps around job steps', () => {
      const pipeline: PipelineDefinition = {
        jobs: [
          {
            job: 'BuildJob',
            steps: [{ pwsh: 'echo build' }],
          },
        ],
      };

      const config = {
        preJob: [{ pwsh: 'echo pre', displayName: 'Pre' }],
        postJob: [{ pwsh: 'echo post', displayName: 'Post' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      const job = result.jobs![0] as { steps: { pwsh: string }[] };
      expect(job.steps).toHaveLength(3);
      expect(job.steps[0].pwsh).toBe('echo pre');
      expect(job.steps[1].pwsh).toBe('echo build');
      expect(job.steps[2].pwsh).toBe('echo post');
    });

    it('injects preStep and postStep around each step', () => {
      const pipeline: PipelineDefinition = {
        steps: [
          { pwsh: 'step1' },
          { pwsh: 'step2' },
        ],
      };

      const config = {
        preStep: [{ pwsh: 'echo before' }],
        postStep: [{ pwsh: 'echo after' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      // 2 original steps × (1 pre + 1 original + 1 post) = 6
      expect(result.steps).toHaveLength(6);
      expect((result.steps![0] as { pwsh: string }).pwsh).toBe('echo before');
      expect((result.steps![1] as { pwsh: string }).pwsh).toBe('step1');
      expect((result.steps![2] as { pwsh: string }).pwsh).toBe('echo after');
      expect((result.steps![3] as { pwsh: string }).pwsh).toBe('echo before');
      expect((result.steps![4] as { pwsh: string }).pwsh).toBe('step2');
      expect((result.steps![5] as { pwsh: string }).pwsh).toBe('echo after');
    });

    it('does not mutate the original pipeline', () => {
      const pipeline: PipelineDefinition = {
        steps: [{ pwsh: 'original' }],
      };

      const config = {
        preJob: [{ pwsh: 'injected' }],
      };

      engine.applyDecorators(pipeline, config);
      expect(pipeline.steps).toHaveLength(1);
    });

    it('applies decorators through stages', () => {
      const pipeline: PipelineDefinition = {
        stages: [
          {
            stage: 'Build',
            jobs: [
              {
                job: 'Job1',
                steps: [{ pwsh: 'build' }],
              },
            ],
          },
        ],
      };

      const config = {
        preJob: [{ pwsh: 'echo pre' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      const job = result.stages![0].jobs![0] as { steps: { pwsh: string }[] };
      expect(job.steps[0].pwsh).toBe('echo pre');
    });

    it('passes through stages without jobs', () => {
      const pipeline: PipelineDefinition = {
        stages: [
          {
            stage: 'EmptyStage',
          },
        ],
      };

      const config = {
        preJob: [{ pwsh: 'echo pre' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      expect(result.stages![0].stage).toBe('EmptyStage');
      expect((result.stages![0] as Record<string, unknown>).jobs).toBeUndefined();
    });

    it('passes through template job references without modification', () => {
      const pipeline: PipelineDefinition = {
        jobs: [
          { template: 'jobs/build.yaml' } as unknown as import('../../src/types/pipeline.js').JobDefinition,
        ],
      };

      const config = {
        preJob: [{ pwsh: 'echo pre' }],
        postJob: [{ pwsh: 'echo post' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      const job = result.jobs![0] as Record<string, unknown>;
      expect(job.template).toBe('jobs/build.yaml');
    });

    it('decorates deployment job lifecycle hooks', () => {
      const pipeline: PipelineDefinition = {
        jobs: [
          {
            deployment: 'web',
            environment: 'prod',
            strategy: {
              runOnce: {
                deploy: {
                  steps: [{ pwsh: 'deploy' }],
                },
              },
            },
          } as unknown as import('../../src/types/pipeline.js').JobDefinition,
        ],
      };

      const config = {
        preJob: [{ pwsh: 'echo pre' }],
        postJob: [{ pwsh: 'echo post' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      const deploy = result.jobs![0] as Record<string, unknown>;
      const strategy = deploy.strategy as Record<string, unknown>;
      const runOnce = strategy.runOnce as Record<string, unknown>;
      const deployHook = runOnce.deploy as { steps: unknown[] };
      // preJob + deploy + postJob = 3
      expect(deployHook.steps).toHaveLength(3);
    });

    it('decorates deployment on.success and on.failure hooks', () => {
      const pipeline: PipelineDefinition = {
        jobs: [
          {
            deployment: 'web',
            environment: 'prod',
            strategy: {
              runOnce: {
                deploy: {
                  steps: [{ pwsh: 'deploy' }],
                },
                on: {
                  success: { steps: [{ pwsh: 'yay' }] },
                  failure: { steps: [{ pwsh: 'oops' }] },
                },
              },
            },
          } as unknown as import('../../src/types/pipeline.js').JobDefinition,
        ],
      };

      const config = {
        preJob: [{ pwsh: 'echo pre' }],
        postJob: [{ pwsh: 'echo post' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      const deploy = result.jobs![0] as Record<string, unknown>;
      const strategy = deploy.strategy as Record<string, unknown>;
      const runOnce = strategy.runOnce as Record<string, unknown>;
      const on = runOnce.on as Record<string, unknown>;
      const success = on.success as { steps: unknown[] };
      const failure = on.failure as { steps: unknown[] };
      // preJob + step + postJob = 3
      expect(success.steps).toHaveLength(3);
      expect(failure.steps).toHaveLength(3);
    });

    it('decorates rolling strategy lifecycle', () => {
      const pipeline: PipelineDefinition = {
        jobs: [
          {
            deployment: 'web',
            environment: 'prod',
            strategy: {
              rolling: {
                maxParallel: 2,
                deploy: {
                  steps: [{ pwsh: 'rolling deploy' }],
                },
              },
            },
          } as unknown as import('../../src/types/pipeline.js').JobDefinition,
        ],
      };

      const config = {
        preJob: [{ pwsh: 'echo pre' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      const deploy = result.jobs![0] as Record<string, unknown>;
      const strategy = deploy.strategy as Record<string, unknown>;
      const rolling = strategy.rolling as Record<string, unknown>;
      const deployHook = rolling.deploy as { steps: unknown[] };
      expect(deployHook.steps.length).toBeGreaterThanOrEqual(2);
    });

    it('decorates canary strategy lifecycle', () => {
      const pipeline: PipelineDefinition = {
        jobs: [
          {
            deployment: 'web',
            environment: 'prod',
            strategy: {
              canary: {
                increments: [25, 50, 100],
                deploy: {
                  steps: [{ pwsh: 'canary deploy' }],
                },
              },
            },
          } as unknown as import('../../src/types/pipeline.js').JobDefinition,
        ],
      };

      const config = {
        postJob: [{ pwsh: 'echo post' }],
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      const deploy = result.jobs![0] as Record<string, unknown>;
      const strategy = deploy.strategy as Record<string, unknown>;
      const canary = strategy.canary as Record<string, unknown>;
      const deployHook = canary.deploy as { steps: unknown[] };
      expect(deployHook.steps.length).toBeGreaterThanOrEqual(2);
    });

    it('handles steps without preStep or postStep (no interleaving needed)', () => {
      const pipeline: PipelineDefinition = {
        steps: [
          { pwsh: 'step1' },
          { pwsh: 'step2' },
        ],
      };

      const config = {
        preJob: [{ pwsh: 'pre' }],
        // no preStep, no postStep
      };

      const result = engine.applyDecorators(pipeline, config) as PipelineDefinition;
      // Steps unchanged (no preStep/postStep interleaving)
      expect(result.steps).toHaveLength(2);
    });

    it('loads preStep and postStep decorator config', async () => {
      const pipelineDir = join(tmpDir, '.pipeline');
      await mkdir(pipelineDir, { recursive: true });
      await writeFile(
        join(pipelineDir, 'decorators.yaml'),
        `
preStep:
  - pwsh: echo "before each step"
postStep:
  - pwsh: echo "after each step"
`,
      );

      const config = await engine.loadDecorators(tmpDir);
      expect(config).not.toBeNull();
      expect(config!.preStep).toHaveLength(1);
      expect(config!.postStep).toHaveLength(1);
    });

    it('returns null for non-object YAML content', async () => {
      const pipelineDir = join(tmpDir, '.pipeline');
      await mkdir(pipelineDir, { recursive: true });
      await writeFile(join(pipelineDir, 'decorators.yaml'), '"just a string"');

      const config = await engine.loadDecorators(tmpDir);
      expect(config).toBeNull();
    });

    it('returns empty config for YAML with no recognized keys', async () => {
      const pipelineDir = join(tmpDir, '.pipeline');
      await mkdir(pipelineDir, { recursive: true });
      await writeFile(join(pipelineDir, 'decorators.yaml'), 'unknownKey: 123');

      const config = await engine.loadDecorators(tmpDir);
      expect(config).not.toBeNull();
      // No preJob/postJob/preStep/postStep recognized
      expect(config!.preJob).toBeUndefined();
    });
  });
});

// ─── VariableGuard ──────────────────────────────────────────────────────────────

describe('VariableGuard', () => {
  let guard: VariableGuard;

  beforeEach(() => {
    guard = new VariableGuard();
  });

  describe('canSet', () => {
    it('allows all variables when restrictions is undefined', () => {
      const result = guard.canSet('anyVar', undefined);
      expect(result.allowed).toBe(true);
    });

    it('blocks all variables when none=true', () => {
      const restrictions: SettableVariablesConfig = { none: true };
      const result = guard.canSet('myVar', restrictions);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('none: true');
    });

    it('allows variables in the allowed list', () => {
      const restrictions: SettableVariablesConfig = {
        allowed: ['deployTarget', 'version'],
      };
      expect(guard.canSet('deployTarget', restrictions).allowed).toBe(true);
      expect(guard.canSet('version', restrictions).allowed).toBe(true);
    });

    it('rejects variables not in the allowed list', () => {
      const restrictions: SettableVariablesConfig = {
        allowed: ['deployTarget'],
      };
      const result = guard.canSet('secretKey', restrictions);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('secretKey');
    });

    it('matches variable names case-insensitively', () => {
      const restrictions: SettableVariablesConfig = {
        allowed: ['DeployTarget'],
      };
      expect(guard.canSet('deploytarget', restrictions).allowed).toBe(true);
      expect(guard.canSet('DEPLOYTARGET', restrictions).allowed).toBe(true);
      expect(guard.canSet('DeployTarget', restrictions).allowed).toBe(true);
    });
  });

  describe('validateVariableOperations', () => {
    it('returns valid when all operations are allowed', () => {
      const restrictions: SettableVariablesConfig = {
        allowed: ['a', 'b'],
      };
      const ops = [
        { name: 'a', action: 'set' as const },
        { name: 'b', action: 'update' as const },
      ];
      const result = guard.validateVariableOperations(ops, restrictions);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('collects all violations', () => {
      const restrictions: SettableVariablesConfig = { none: true };
      const ops = [
        { name: 'x', action: 'set' as const },
        { name: 'y', action: 'set' as const },
      ];
      const result = guard.validateVariableOperations(ops, restrictions);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(2);
    });

    it('allows all operations when restrictions is undefined', () => {
      const ops = [
        { name: 'anything', action: 'set' as const },
      ];
      const result = guard.validateVariableOperations(ops, undefined);
      expect(result.valid).toBe(true);
    });
  });
});
