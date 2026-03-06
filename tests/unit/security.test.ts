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
