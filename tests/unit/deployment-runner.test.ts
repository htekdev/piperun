import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  DeploymentJobDefinition,
  DeploymentLifecycle,
  PipelineRunContext,
  PipelineStatus,
} from '../../src/types/pipeline.js';
import type { ExpressionEngine } from '../../src/compiler/expression-engine.js';
import type { ConditionEvaluator } from '../../src/runtime/condition-evaluator.js';
import { VariableManager } from '../../src/variables/variable-manager.js';
import { OutputVariableStore } from '../../src/variables/output-variables.js';
import { SecretMasker } from '../../src/variables/secret-masker.js';
import {
  DeploymentRunner,
  type DeploymentRunResult,
  type DeploymentRunnerDeps,
  type DeploymentRunnerOptions,
} from '../../src/runtime/deployment-runner.js';

// ─── Mock helpers ───────────────────────────────────────────────────────────

function createMockExpressionEngine(): ExpressionEngine {
  return {
    evaluateCompileTime: vi.fn((_input, _context) => ''),
    evaluateRuntime: vi.fn((_input, _context) => ''),
    expandMacros: vi.fn((input, _vars) => input),
    processObject: vi.fn((obj, _context, _mode) => obj),
  };
}

function createMockConditionEvaluator(): ConditionEvaluator {
  return {
    evaluate: vi.fn(() => true),
    getDefaultCondition: vi.fn(() => 'succeeded()'),
  } as unknown as ConditionEvaluator;
}

function createPipelineContext(): PipelineRunContext {
  return {
    runId: 'test-run-001',
    runNumber: 1,
    pipelineName: 'test-pipeline',
    startTime: new Date(),
    status: 'running',
    stages: new Map(),
  };
}

function createRunner(
  depsOverrides?: Partial<DeploymentRunnerDeps>,
  optionsOverrides?: Partial<DeploymentRunnerOptions>,
): DeploymentRunner {
  const secretMasker = new SecretMasker();
  const variableManager = new VariableManager(secretMasker);
  variableManager.enterScope('pipeline', 'test-pipeline');

  const deps: DeploymentRunnerDeps = {
    variableManager,
    outputStore: new OutputVariableStore(),
    expressionEngine: createMockExpressionEngine(),
    conditionEvaluator: createMockConditionEvaluator(),
    secretMasker,
    ...depsOverrides,
  };

  const options: DeploymentRunnerOptions = {
    workingDirectory: process.cwd(),
    verbose: false,
    ...optionsOverrides,
  };

  return new DeploymentRunner(deps, options);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('DeploymentRunner', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // ─── runOnce lifecycle ─────────────────────────────────────────────

  describe('runOnce strategy', () => {
    it('executes lifecycle hooks in order: preDeploy → deploy → routeTraffic → postRouteTraffic → on.success', async () => {
      const runner = createRunner();
      const ctx = createPipelineContext();

      const hookOrder: string[] = [];

      const job: DeploymentJobDefinition = {
        deployment: 'web-app',
        environment: 'production',
        strategy: {
          runOnce: {
            preDeploy: {
              steps: [
                {
                  node: `process.stdout.write('preDeploy');`,
                  displayName: 'PreDeploy Step',
                },
              ],
            },
            deploy: {
              steps: [
                {
                  node: `process.stdout.write('deploy');`,
                  displayName: 'Deploy Step',
                },
              ],
            },
            routeTraffic: {
              steps: [
                {
                  node: `process.stdout.write('routeTraffic');`,
                  displayName: 'Route Traffic Step',
                },
              ],
            },
            postRouteTraffic: {
              steps: [
                {
                  node: `process.stdout.write('postRouteTraffic');`,
                  displayName: 'PostRoute Step',
                },
              ],
            },
            on: {
              success: {
                steps: [
                  {
                    node: `process.stdout.write('on.success');`,
                    displayName: 'Success Step',
                  },
                ],
              },
              failure: {
                steps: [
                  {
                    node: `process.stdout.write('on.failure');`,
                    displayName: 'Failure Step',
                  },
                ],
              },
            },
          },
        },
      };

      const result = await runner.runDeployment(job, ctx);

      expect(result.status).toBe('succeeded');
      expect(result.environment).toBe('production');
      expect(result.strategy).toBe('runOnce');

      const hookNames = result.hooks.map((h) => h.name);
      expect(hookNames).toEqual([
        'preDeploy',
        'deploy',
        'routeTraffic',
        'postRouteTraffic',
        'on.success',
      ]);

      // All hooks should have succeeded
      for (const hook of result.hooks) {
        expect(hook.status).toBe('succeeded');
      }
    });

    it('triggers on.failure when a main hook fails', async () => {
      const runner = createRunner();
      const ctx = createPipelineContext();

      const job: DeploymentJobDefinition = {
        deployment: 'web-app',
        environment: 'staging',
        strategy: {
          runOnce: {
            preDeploy: {
              steps: [
                {
                  node: `process.stdout.write('ok');`,
                  displayName: 'PreDeploy Step',
                },
              ],
            },
            deploy: {
              steps: [
                {
                  node: `process.exit(1);`,
                  displayName: 'Failing Deploy',
                },
              ],
            },
            routeTraffic: {
              steps: [
                {
                  node: `process.stdout.write('should not run');`,
                  displayName: 'Route Traffic Step',
                },
              ],
            },
            on: {
              success: {
                steps: [
                  {
                    node: `process.stdout.write('success');`,
                    displayName: 'Success Step',
                  },
                ],
              },
              failure: {
                steps: [
                  {
                    node: `process.stdout.write('failure handler');`,
                    displayName: 'Failure Step',
                  },
                ],
              },
            },
          },
        },
      };

      const result = await runner.runDeployment(job, ctx);

      expect(result.status).toBe('failed');

      const hookNames = result.hooks.map((h) => h.name);
      // preDeploy succeeded, deploy failed, routeTraffic skipped, on.failure runs
      expect(hookNames).toEqual(['preDeploy', 'deploy', 'on.failure']);

      // Should NOT have on.success
      expect(hookNames).not.toContain('on.success');
      // Should NOT have routeTraffic (skipped after deploy failure)
      expect(hookNames).not.toContain('routeTraffic');
    });

    it('skips missing hooks without error', async () => {
      const runner = createRunner();
      const ctx = createPipelineContext();

      // Only define deploy hook — all others are optional
      const job: DeploymentJobDefinition = {
        deployment: 'minimal-deploy',
        environment: 'test',
        strategy: {
          runOnce: {
            deploy: {
              steps: [
                {
                  node: `process.stdout.write('deploying');`,
                  displayName: 'Deploy',
                },
              ],
            },
          },
        },
      };

      const result = await runner.runDeployment(job, ctx);

      expect(result.status).toBe('succeeded');
      const hookNames = result.hooks.map((h) => h.name);
      expect(hookNames).toEqual(['deploy']);
    });
  });

  // ─── rolling strategy ──────────────────────────────────────────────

  describe('rolling strategy', () => {
    it('executes hooks for rolling strategy', async () => {
      const runner = createRunner();
      const ctx = createPipelineContext();

      const job: DeploymentJobDefinition = {
        deployment: 'rolling-app',
        environment: 'prod',
        strategy: {
          rolling: {
            maxParallel: 2,
            deploy: {
              steps: [
                {
                  node: `process.stdout.write('rolling deploy');`,
                  displayName: 'Rolling Deploy',
                },
              ],
            },
          },
        },
      };

      const result = await runner.runDeployment(job, ctx);

      expect(result.status).toBe('succeeded');
      expect(result.strategy).toBe('rolling');
      expect(result.hooks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── canary strategy ───────────────────────────────────────────────

  describe('canary strategy', () => {
    it('runs hooks once per increment', async () => {
      const runner = createRunner();
      const ctx = createPipelineContext();

      const job: DeploymentJobDefinition = {
        deployment: 'canary-app',
        environment: 'prod',
        strategy: {
          canary: {
            increments: [10, 50, 100],
            deploy: {
              steps: [
                {
                  node: `process.stdout.write('canary deploy');`,
                  displayName: 'Canary Deploy',
                },
              ],
            },
          },
        },
      };

      const result = await runner.runDeployment(job, ctx);

      expect(result.status).toBe('succeeded');
      expect(result.strategy).toBe('canary');

      // Should have 3 deploy hooks (one per increment)
      const deployHooks = result.hooks.filter((h) => h.name === 'deploy');
      expect(deployHooks).toHaveLength(3);
    });

    it('stops canary increments on failure', async () => {
      const runner = createRunner();
      const ctx = createPipelineContext();

      let callCount = 0;

      const job: DeploymentJobDefinition = {
        deployment: 'canary-fail',
        environment: 'prod',
        strategy: {
          canary: {
            increments: [10, 50, 100],
            deploy: {
              steps: [
                {
                  // Fail on second increment
                  node: `
                    const env = process.env;
                    process.exit(0);
                  `,
                  displayName: 'Canary Step',
                },
              ],
            },
            preDeploy: {
              steps: [
                {
                  // Fail on second call
                  node: `process.exit(1);`,
                  displayName: 'Failing preDeploy',
                },
              ],
            },
          },
        },
      };

      const result = await runner.runDeployment(job, ctx);

      expect(result.status).toBe('failed');
      // Should stop after first increment due to preDeploy failure
      // preDeploy fails on first increment, so only 1 set of hooks + on.failure if defined
      expect(result.hooks.length).toBeLessThanOrEqual(3);
    });
  });

  // ─── Deployment result metadata ────────────────────────────────────

  describe('result metadata', () => {
    it('captures environment and strategy in result', async () => {
      const runner = createRunner();
      const ctx = createPipelineContext();

      const job: DeploymentJobDefinition = {
        deployment: 'meta-test',
        environment: { name: 'staging', resourceType: 'virtualMachine' },
        strategy: {
          runOnce: {
            deploy: {
              steps: [
                { node: `process.stdout.write('ok');`, displayName: 'Deploy' },
              ],
            },
          },
        },
      };

      const result = await runner.runDeployment(job, ctx);

      expect(result.name).toBe('meta-test');
      expect(result.environment).toBe('staging');
      expect(result.strategy).toBe('runOnce');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('handles no strategy gracefully', async () => {
      const runner = createRunner();
      const ctx = createPipelineContext();

      const job: DeploymentJobDefinition = {
        deployment: 'no-strategy',
        environment: 'dev',
        strategy: {},
      };

      const result = await runner.runDeployment(job, ctx);

      expect(result.status).toBe('succeeded');
      expect(result.strategy).toBe('none');
    });
  });
});
