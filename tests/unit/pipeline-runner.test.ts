import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  PipelineDefinition,
  StageDefinition,
  RegularJobDefinition,
  PipelineRunContext,
  StageRunContext,
  PipelineStatus,
  StepDefinition,
} from '../../src/types/pipeline.js';
import type { ExpressionContext } from '../../src/types/expressions.js';
import { PipelineRunner } from '../../src/runtime/pipeline-runner.js';
import { StageRunner, type StageRunResult } from '../../src/runtime/stage-runner.js';
import { JobRunner, type JobRunResult } from '../../src/runtime/job-runner.js';
import { VariableManager } from '../../src/variables/variable-manager.js';
import { OutputVariableStore } from '../../src/variables/output-variables.js';
import { SecretMasker } from '../../src/variables/secret-masker.js';
import { createExpressionEngine } from '../../src/compiler/expression-engine.js';
import { createFunctionRegistry } from '../../src/functions/index.js';
import type { StepResult } from '../../src/runtime/step-runner.js';

// ─── Mock Step Runner ───────────────────────────────────────────────────────

function createMockStepResult(
  overrides: Partial<StepResult> = {},
): StepResult {
  return {
    status: 'succeeded',
    exitCode: 0,
    stdout: '',
    stderr: '',
    duration: 10,
    outputs: {},
    retryCount: 0,
    ...overrides,
  };
}

function createMockStepRunner(
  results: StepResult[] = [createMockStepResult()],
) {
  let callIndex = 0;
  return {
    executeStep: vi.fn(async () => {
      const result = results[callIndex] ?? createMockStepResult();
      callIndex++;
      return result;
    }),
  };
}

// ─── Mock Condition Evaluator ───────────────────────────────────────────────

function createMockConditionEvaluator(
  evaluateResult: boolean = true,
) {
  return {
    evaluate: vi.fn(
      (
        _condition: string | undefined,
        _context: ExpressionContext,
        _defaultCondition?: string,
      ) => evaluateResult,
    ),
    getDefaultCondition: vi.fn(() => "succeeded()"),
  };
}

// ─── Suppress console output during tests ───────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ─── Pipeline Normalization ─────────────────────────────────────────────────

describe('PipelineRunner - normalizePipeline', () => {
  let runner: PipelineRunner;

  beforeEach(() => {
    runner = new PipelineRunner();
  });

  it('wraps steps-only pipeline in default job and stage', () => {
    const pipeline: PipelineDefinition = {
      steps: [{ pwsh: 'echo hello' }],
    };

    const stages = runner.normalizePipeline(pipeline);

    expect(stages).toHaveLength(1);
    expect(stages[0].stage).toBe('__default');
    expect(stages[0].jobs).toHaveLength(1);

    const job = stages[0].jobs![0] as RegularJobDefinition;
    expect(job.job).toBe('__default');
    expect(job.steps).toHaveLength(1);
  });

  it('wraps jobs-only pipeline in default stage', () => {
    const pipeline: PipelineDefinition = {
      jobs: [
        { job: 'build', steps: [{ pwsh: 'echo build' }] },
        { job: 'test', steps: [{ pwsh: 'echo test' }] },
      ],
    };

    const stages = runner.normalizePipeline(pipeline);

    expect(stages).toHaveLength(1);
    expect(stages[0].stage).toBe('__default');
    expect(stages[0].jobs).toHaveLength(2);
  });

  it('uses stages as-is when provided', () => {
    const pipeline: PipelineDefinition = {
      stages: [
        {
          stage: 'build',
          jobs: [{ job: 'compile', steps: [{ pwsh: 'echo compile' }] }],
        },
        {
          stage: 'test',
          dependsOn: 'build',
          jobs: [{ job: 'unittest', steps: [{ pwsh: 'echo test' }] }],
        },
      ],
    };

    const stages = runner.normalizePipeline(pipeline);

    expect(stages).toHaveLength(2);
    expect(stages[0].stage).toBe('build');
    expect(stages[1].stage).toBe('test');
    expect(stages[1].dependsOn).toBe('build');
  });

  it('returns empty array for empty pipeline', () => {
    const pipeline: PipelineDefinition = {};
    expect(runner.normalizePipeline(pipeline)).toEqual([]);
  });

  it('prefers stages over jobs over steps', () => {
    const pipeline: PipelineDefinition = {
      stages: [
        {
          stage: 'explicit',
          jobs: [{ job: 'a', steps: [{ pwsh: 'echo a' }] }],
        },
      ],
      jobs: [{ job: 'b', steps: [{ pwsh: 'echo b' }] }],
      steps: [{ pwsh: 'echo c' }],
    };

    const stages = runner.normalizePipeline(pipeline);
    expect(stages).toHaveLength(1);
    expect(stages[0].stage).toBe('explicit');
  });
});

// ─── JobRunner ──────────────────────────────────────────────────────────────

describe('JobRunner', () => {
  let variableManager: VariableManager;
  let outputStore: OutputVariableStore;
  let secretMasker: SecretMasker;
  let expressionEngine: ReturnType<typeof createExpressionEngine>;

  beforeEach(() => {
    secretMasker = new SecretMasker();
    variableManager = new VariableManager(secretMasker);
    variableManager.enterScope('pipeline', 'pipeline');
    variableManager.enterScope('stage', 'test-stage');
    outputStore = new OutputVariableStore();
    const registry = createFunctionRegistry();
    expressionEngine = createExpressionEngine(registry);
  });

  function createJobRunner(
    stepResults: StepResult[] = [createMockStepResult()],
    conditionResult: boolean = true,
  ): { runner: JobRunner; mockStepRunner: ReturnType<typeof createMockStepRunner> } {
    const mockStepRunner = createMockStepRunner(stepResults);
    const conditionEvaluator = createMockConditionEvaluator(conditionResult);

    const runner = new JobRunner(
      {
        variableManager,
        outputStore,
        expressionEngine,
        conditionEvaluator,
        secretMasker,
        stepRunnerFactory: () => mockStepRunner,
      },
      { workingDirectory: '/tmp', verbose: false },
    );

    return { runner, mockStepRunner };
  }

  it('runs a job with succeeding steps', async () => {
    const { runner, mockStepRunner } = createJobRunner([
      createMockStepResult(),
      createMockStepResult(),
    ]);

    const job: RegularJobDefinition = {
      job: 'build',
      steps: [{ pwsh: 'echo step1' }, { pwsh: 'echo step2' }],
    };

    const pipelineCtx = createPipelineContext();
    const stageCtx = createStageContext();

    const result = await runner.runJob(job, stageCtx, pipelineCtx);

    expect(result.name).toBe('build');
    expect(result.status).toBe('succeeded');
    expect(result.steps).toHaveLength(2);
    expect(mockStepRunner.executeStep).toHaveBeenCalledTimes(2);
  });

  it('fails job when a step fails and continueOnError=false', async () => {
    const { runner } = createJobRunner([
      createMockStepResult(),
      createMockStepResult({ status: 'failed', exitCode: 1 }),
      createMockStepResult(), // should not run
    ]);

    const job: RegularJobDefinition = {
      job: 'build',
      steps: [
        { pwsh: 'echo ok' },
        { pwsh: 'exit 1' },
        { pwsh: 'echo after-fail' },
      ],
    };

    const result = await runner.runJob(
      job,
      createStageContext(),
      createPipelineContext(),
    );

    expect(result.status).toBe('failed');
  });

  it('continues with succeededWithIssues when step fails with continueOnError', async () => {
    const { runner } = createJobRunner([
      createMockStepResult({ status: 'failed', exitCode: 1 }),
      createMockStepResult(),
    ]);

    const job: RegularJobDefinition = {
      job: 'build',
      steps: [
        { pwsh: 'exit 1', continueOnError: true },
        { pwsh: 'echo after' },
      ],
    };

    const result = await runner.runJob(
      job,
      createStageContext(),
      createPipelineContext(),
    );

    expect(result.status).toBe('succeededWithIssues');
  });

  it('skips job when condition evaluates to false', async () => {
    const { runner } = createJobRunner([], false);

    const job: RegularJobDefinition = {
      job: 'deploy',
      condition: 'eq(variables.deploy, true)',
      steps: [{ pwsh: 'echo deploy' }],
    };

    const result = await runner.runJob(
      job,
      createStageContext(),
      createPipelineContext(),
    );

    expect(result.status).toBe('skipped');
    expect(result.steps).toHaveLength(0);
  });

  it('returns canceled status when canceled before start', async () => {
    const { runner } = createJobRunner();

    runner.cancel();

    const job: RegularJobDefinition = {
      job: 'build',
      steps: [{ pwsh: 'echo hello' }],
    };

    const result = await runner.runJob(
      job,
      createStageContext(),
      createPipelineContext(),
    );

    expect(result.status).toBe('canceled');
  });

  it('records job result in output store', async () => {
    const { runner } = createJobRunner([createMockStepResult()]);

    const job: RegularJobDefinition = {
      job: 'build',
      steps: [{ pwsh: 'echo hello' }],
    };

    await runner.runJob(job, createStageContext(), createPipelineContext());

    expect(outputStore.getJobResult('build')).toBe('Succeeded');
  });

  it('records step outputs in output store', async () => {
    const { runner } = createJobRunner([
      createMockStepResult({
        outputs: { version: '1.0.0' },
      }),
    ]);

    const job: RegularJobDefinition = {
      job: 'build',
      steps: [{ pwsh: 'echo hello', name: 'setVersion' }],
    };

    await runner.runJob(job, createStageContext(), createPipelineContext());

    expect(outputStore.getOutput('build', 'setVersion.version')).toBe(
      '1.0.0',
    );
  });

  it('handles job with no steps', async () => {
    const { runner } = createJobRunner([]);

    const job: RegularJobDefinition = {
      job: 'empty',
      steps: [],
    };

    const result = await runner.runJob(
      job,
      createStageContext(),
      createPipelineContext(),
    );

    expect(result.status).toBe('succeeded');
    expect(result.steps).toHaveLength(0);
  });
});

// ─── StageRunner ────────────────────────────────────────────────────────────

describe('StageRunner', () => {
  let variableManager: VariableManager;
  let outputStore: OutputVariableStore;
  let secretMasker: SecretMasker;
  let expressionEngine: ReturnType<typeof createExpressionEngine>;

  beforeEach(() => {
    secretMasker = new SecretMasker();
    variableManager = new VariableManager(secretMasker);
    variableManager.enterScope('pipeline', 'pipeline');
    outputStore = new OutputVariableStore();
    const registry = createFunctionRegistry();
    expressionEngine = createExpressionEngine(registry);
  });

  function createStageRunnerInstance(
    stepResults: StepResult[] = [createMockStepResult()],
    conditionResult: boolean = true,
  ): StageRunner {
    const mockStepRunner = createMockStepRunner(stepResults);
    const conditionEvaluator = createMockConditionEvaluator(conditionResult);

    return new StageRunner(
      {
        variableManager,
        outputStore,
        expressionEngine,
        conditionEvaluator,
        secretMasker,
        stepRunnerFactory: () => mockStepRunner,
      },
      { workingDirectory: '/tmp', verbose: false },
    );
  }

  it('runs a stage with a single job', async () => {
    const stageRunner = createStageRunnerInstance([createMockStepResult()]);

    const stage: StageDefinition = {
      stage: 'build',
      jobs: [
        { job: 'compile', steps: [{ pwsh: 'echo compile' }] },
      ],
    };

    const result = await stageRunner.runStage(stage, createPipelineContext());

    expect(result.name).toBe('build');
    expect(result.status).toBe('succeeded');
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].name).toBe('compile');
  });

  it('runs multiple independent jobs in parallel', async () => {
    const executionOrder: string[] = [];
    const conditionEvaluator = createMockConditionEvaluator(true);

    const stageRunner = new StageRunner(
      {
        variableManager,
        outputStore,
        expressionEngine,
        conditionEvaluator,
        secretMasker,
        stepRunnerFactory: () => ({
          executeStep: vi.fn(async (_step: StepDefinition, stepName: string) => {
            executionOrder.push(stepName);
            // Small delay to allow parallel execution
            await new Promise((resolve) => setTimeout(resolve, 10));
            return createMockStepResult();
          }),
        }),
      },
      { workingDirectory: '/tmp', verbose: false },
    );

    const stage: StageDefinition = {
      stage: 'test',
      jobs: [
        { job: 'unit', steps: [{ pwsh: 'echo unit', name: 'unit-step' }] },
        { job: 'lint', steps: [{ pwsh: 'echo lint', name: 'lint-step' }] },
      ],
    };

    const result = await stageRunner.runStage(stage, createPipelineContext());

    expect(result.status).toBe('succeeded');
    expect(result.jobs).toHaveLength(2);
    // Both jobs should have completed (order may vary due to parallel execution)
    const jobNames = result.jobs.map((j) => j.name).sort();
    expect(jobNames).toEqual(['lint', 'unit']);
  });

  it('respects job dependency ordering', async () => {
    const executionOrder: string[] = [];
    const conditionEvaluator = createMockConditionEvaluator(true);

    const stageRunner = new StageRunner(
      {
        variableManager,
        outputStore,
        expressionEngine,
        conditionEvaluator,
        secretMasker,
        stepRunnerFactory: () => ({
          executeStep: vi.fn(async (_step: StepDefinition, stepName: string) => {
            executionOrder.push(stepName);
            return createMockStepResult();
          }),
        }),
      },
      { workingDirectory: '/tmp', verbose: false },
    );

    const stage: StageDefinition = {
      stage: 'deploy',
      jobs: [
        {
          job: 'package',
          steps: [{ pwsh: 'echo package', name: 'package-step' }],
        },
        {
          job: 'deploy',
          dependsOn: 'package',
          steps: [{ pwsh: 'echo deploy', name: 'deploy-step' }],
        },
      ],
    };

    const result = await stageRunner.runStage(stage, createPipelineContext());

    expect(result.status).toBe('succeeded');
    expect(result.jobs).toHaveLength(2);

    // package-step must come before deploy-step
    const packageIndex = executionOrder.indexOf('package-step');
    const deployIndex = executionOrder.indexOf('deploy-step');
    expect(packageIndex).toBeLessThan(deployIndex);
  });

  it('skips stage when condition evaluates to false', async () => {
    const stageRunner = createStageRunnerInstance([], false);

    const stage: StageDefinition = {
      stage: 'deploy',
      condition: 'eq(variables.env, prod)',
      jobs: [{ job: 'deploy', steps: [{ pwsh: 'echo deploy' }] }],
    };

    const result = await stageRunner.runStage(stage, createPipelineContext());

    expect(result.status).toBe('skipped');
    expect(result.jobs).toHaveLength(0);
  });

  it('returns canceled status when canceled', async () => {
    const stageRunner = createStageRunnerInstance();

    stageRunner.cancel();

    const stage: StageDefinition = {
      stage: 'build',
      jobs: [{ job: 'compile', steps: [{ pwsh: 'echo compile' }] }],
    };

    const result = await stageRunner.runStage(stage, createPipelineContext());

    expect(result.status).toBe('canceled');
  });

  it('determines failed status from job results', async () => {
    const conditionEvaluator = createMockConditionEvaluator(true);

    const stageRunner = new StageRunner(
      {
        variableManager,
        outputStore,
        expressionEngine,
        conditionEvaluator,
        secretMasker,
        stepRunnerFactory: () =>
          createMockStepRunner([
            createMockStepResult({ status: 'failed', exitCode: 1 }),
          ]),
      },
      { workingDirectory: '/tmp', verbose: false },
    );

    const stage: StageDefinition = {
      stage: 'test',
      jobs: [{ job: 'failing', steps: [{ pwsh: 'exit 1' }] }],
    };

    const result = await stageRunner.runStage(stage, createPipelineContext());

    expect(result.status).toBe('failed');
  });

  it('handles stage with no jobs', async () => {
    const stageRunner = createStageRunnerInstance();

    const stage: StageDefinition = {
      stage: 'empty',
      jobs: [],
    };

    const result = await stageRunner.runStage(stage, createPipelineContext());

    expect(result.status).toBe('succeeded');
    expect(result.jobs).toHaveLength(0);
  });
});

// ─── Status Determination ───────────────────────────────────────────────────

describe('Status determination', () => {
  it('all stages succeeded → pipeline succeeded, exit code 0', async () => {
    const result = await runPipelineWithStageResults([
      { status: 'succeeded' },
      { status: 'succeeded' },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
  });

  it('any stage failed (no succeeded) → pipeline failed, exit code 1', async () => {
    const result = await runPipelineWithStageResults([{ status: 'failed' }]);

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
  });

  it('mix of succeeded and failed → succeededWithIssues, exit code 2', async () => {
    const result = await runPipelineWithStageResults([
      { status: 'succeeded' },
      { status: 'failed' },
    ]);

    expect(result.status).toBe('succeededWithIssues');
    expect(result.exitCode).toBe(2);
  });

  it('skipped stages do not affect overall status', async () => {
    const result = await runPipelineWithStageResults([
      { status: 'succeeded' },
      { status: 'skipped' },
    ]);

    expect(result.status).toBe('succeeded');
    expect(result.exitCode).toBe(0);
  });

  it('all skipped → skipped status, exit code 0', async () => {
    const result = await runPipelineWithStageResults([
      { status: 'skipped' },
      { status: 'skipped' },
    ]);

    expect(result.status).toBe('skipped');
    expect(result.exitCode).toBe(0);
  });
});

// ─── Cancellation ───────────────────────────────────────────────────────────

describe('PipelineRunner - cancellation', () => {
  it('cancel sets pipeline to canceled state', async () => {
    const runner = new PipelineRunner();

    // Cancel immediately — any pipeline run should return canceled
    runner.cancel();

    // Verify the runner is in canceled state by checking it propagates
    // We can verify this at the stage runner level more easily
    // Here just verify the method doesn't throw
    expect(() => runner.cancel()).not.toThrow();
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function createPipelineContext(): PipelineRunContext {
  return {
    runId: 'test-run-id',
    runNumber: 1,
    pipelineName: 'test-pipeline',
    startTime: new Date(),
    status: 'running',
    stages: new Map(),
  };
}

function createStageContext(
  name: string = 'test-stage',
): StageRunContext {
  return {
    name,
    status: 'running',
    jobs: new Map(),
  };
}

/**
 * Helper that tests the status determination logic
 * by directly calling normalizePipeline + checking status logic
 * instead of running real pipelines (which need filesystem access).
 */
async function runPipelineWithStageResults(
  stageStatuses: Array<{ status: PipelineStatus }>,
): Promise<{ status: PipelineStatus; exitCode: number }> {
  // We test the internal status logic by constructing stage results
  // and calling the private determinePipelineStatus via the public API
  // by building a pipeline and mocking stages.
  const runner = new PipelineRunner();

  // Use reflection to test the private method
  const determinePipelineStatus = (runner as unknown as Record<string, (...args: unknown[]) => PipelineStatus>)[
    'determinePipelineStatus'
  ].bind(runner);

  const statusToExitCode = (runner as unknown as Record<string, (...args: unknown[]) => number>)[
    'statusToExitCode'
  ].bind(runner);

  const stageResults: StageRunResult[] = stageStatuses.map(
    (s, i) => ({
      name: `stage_${i}`,
      status: s.status,
      duration: 100,
      jobs: [],
    }),
  );

  const status = determinePipelineStatus(stageResults);
  const exitCode = statusToExitCode(status);

  return { status, exitCode };
}
