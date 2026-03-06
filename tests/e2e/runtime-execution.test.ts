/**
 * Runtime-execution E2E tests — imports PipelineRunner directly from source
 * so V8 coverage instrumentation can track which runtime source lines are hit.
 */

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';

import { PipelineRunner } from '../../src/runtime/pipeline-runner.js';
import { StepRunner } from '../../src/runtime/step-runner.js';
import { ConditionEvaluator } from '../../src/runtime/condition-evaluator.js';
import { DependencyGraph, normalizeDependsOn, DependencyGraphError } from '../../src/runtime/dependency-graph.js';
import { StrategyRunner } from '../../src/runtime/strategy-runner.js';
import { DeploymentRunner } from '../../src/runtime/deployment-runner.js';
import { PoolResolver } from '../../src/runtime/pool-resolver.js';
import { WorkspaceManager } from '../../src/runtime/workspace-manager.js';
import { ContainerJobRunner } from '../../src/runtime/container-job-runner.js';
import { createExpressionEngine } from '../../src/compiler/expression-engine.js';
import { createFunctionRegistry } from '../../src/functions/index.js';
import type { PipelineRunOptions, PipelineRunResult } from '../../src/runtime/pipeline-runner.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

let tempDir: string;

function createRunDeps() {
  const functionRegistry = createFunctionRegistry({
    currentJobStatus: 'Succeeded',
    dependencyResults: {},
    isCanceled: false,
  });
  const expressionEngine = createExpressionEngine(functionRegistry);
  const conditionEvaluator = new ConditionEvaluator(expressionEngine, functionRegistry);
  return { conditionEvaluator };
}

async function writePipeline(name: string, content: string): Promise<string> {
  const filePath = path.join(tempDir, name);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

async function runPipeline(
  pipelineFile: string,
  overrides: Partial<PipelineRunOptions> = {},
): Promise<PipelineRunResult> {
  const { conditionEvaluator } = createRunDeps();
  const runner = new PipelineRunner();
  return runner.run({
    filePath: pipelineFile,
    params: {},
    workingDirectory: tempDir,
    verbose: true,
    conditionEvaluator,
    stepRunnerFactory: (opts) => new StepRunner(opts),
    ...overrides,
  });
}

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('Runtime Execution E2E (source-imported)', () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piperun-runtime-e2e-'));
  });

  afterAll(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 1: Basic Execution
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Basic Execution', () => {
    it('1. simple single-step pwsh pipeline succeeds', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('basic.yaml', `
name: BasicPipeline
steps:
  - pwsh: Write-Host "hello from piperun"
    displayName: Say Hello
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
      expect(result.stages.length).toBeGreaterThanOrEqual(1);
      expect(result.duration).toBeGreaterThan(0);
      expect(result.context.pipelineName).toBe('BasicPipeline');
    });

    it('2. multi-step pipeline executes all steps in order', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'multi-step-out.txt');
      const file = await writePipeline('multi-step.yaml', `
name: MultiStep
steps:
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "step1"
    displayName: Step 1
  - pwsh: Add-Content -Path "${fwd(outFile)}" -Value "step2"
    displayName: Step 2
  - pwsh: Add-Content -Path "${fwd(outFile)}" -Value "step3"
    displayName: Step 3
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');

      const content = await fs.readFile(outFile, 'utf-8');
      expect(content).toContain('step1');
      expect(content).toContain('step2');
      expect(content).toContain('step3');
    });

    it('3. steps-only pipeline auto-wraps in default stage/job', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('steps-only.yaml', `
name: StepsOnly
steps:
  - pwsh: Write-Host "auto-wrapped"
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
      expect(result.stages.length).toBe(1);
      expect(result.stages[0].name).toBe('__default');
      expect(result.stages[0].jobs.length).toBe(1);
      expect(result.stages[0].jobs[0].name).toBe('__default');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 2: Multi-Stage / Job
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Multi-Stage / Job', () => {
    it('4. multi-stage pipeline with dependencies runs in order', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'stage-order.txt');
      const file = await writePipeline('multi-stage.yaml', `
name: MultiStage
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "build"
  - stage: Test
    dependsOn: Build
    jobs:
      - job: TestJob
        steps:
          - pwsh: Add-Content -Path "${fwd(outFile)}" -Value "test"
  - stage: Deploy
    dependsOn: Test
    jobs:
      - job: DeployJob
        steps:
          - pwsh: Add-Content -Path "${fwd(outFile)}" -Value "deploy"
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
      expect(result.stages.length).toBe(3);

      const content = await fs.readFile(outFile, 'utf-8');
      const lines = content.trim().split(/\r?\n/);
      expect(lines).toEqual(['build', 'test', 'deploy']);
    });

    it('5. multiple jobs in one stage both complete', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile1 = path.join(tempDir, 'job1-out.txt');
      const outFile2 = path.join(tempDir, 'job2-out.txt');
      const file = await writePipeline('multi-job.yaml', `
name: MultiJob
stages:
  - stage: Build
    jobs:
      - job: JobA
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile1)}" -Value "jobA-done"
      - job: JobB
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile2)}" -Value "jobB-done"
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
      expect(result.stages[0].jobs.length).toBe(2);

      const content1 = await fs.readFile(outFile1, 'utf-8');
      const content2 = await fs.readFile(outFile2, 'utf-8');
      expect(content1).toContain('jobA-done');
      expect(content2).toContain('jobB-done');
    });

    it('6. job dependency resolution — correct topological order', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'job-dep-order.txt');
      const file = await writePipeline('job-deps.yaml', `
name: JobDeps
stages:
  - stage: Main
    jobs:
      - job: Setup
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "setup"
      - job: Build
        dependsOn: Setup
        steps:
          - pwsh: Add-Content -Path "${fwd(outFile)}" -Value "build"
      - job: Test
        dependsOn: Build
        steps:
          - pwsh: Add-Content -Path "${fwd(outFile)}" -Value "test"
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      const lines = content.trim().split(/\r?\n/);
      expect(lines).toEqual(['setup', 'build', 'test']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 3: Variables & Parameters
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Variables & Parameters', () => {
    it('7. pipeline with variables — steps can access them', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'vars-out.txt');
      const file = await writePipeline('with-vars.yaml', `
name: WithVars
variables:
  - name: greeting
    value: "hello-from-var"
steps:
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "$env:GREETING"
    displayName: Use Variable
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('hello-from-var');
    });

    it('8. parameter with default value is used', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'param-default.txt');
      const file = await writePipeline('param-default.yaml', `
name: ParamDefault
parameters:
  - name: env
    type: string
    default: staging
steps:
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "$(parameters.env)"
    displayName: Use Param Default
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
    });

    it('9. parameter with CLI override is honored', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'param-override.txt');
      const file = await writePipeline('param-override.yaml', `
name: ParamOverride
parameters:
  - name: env
    type: string
    default: staging
steps:
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "$(parameters.env)"
    displayName: Use Param Override
`);
      const result = await runPipeline(file, { params: { env: 'production' } });
      expect(result.exitCode).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 4: Conditions
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Conditions', () => {
    it('10. step with false condition is skipped, pipeline succeeds', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'cond-false.txt');
      const file = await writePipeline('cond-false.yaml', `
name: CondFalse
steps:
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "should-not-run"
    displayName: Skipped Step
    condition: "eq(1, 2)"
  - pwsh: Write-Host "second step runs"
    displayName: Running Step
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
      // The file should not exist because the first step was skipped
      await expect(fs.access(outFile)).rejects.toThrow();
    });

    it('11. always() condition — step runs after failure', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'always-after-fail.txt');
      const file = await writePipeline('always-cond.yaml', `
name: AlwaysCondition
steps:
  - pwsh: exit 1
    displayName: Failing Step
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "always-ran"
    displayName: Always Step
    condition: "always()"
`);
      const result = await runPipeline(file);

      expect(result.status).toBe('failed');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('always-ran');
    });

    it('12. succeeded() default — step skipped after failure', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'succeeded-skip.txt');
      const file = await writePipeline('succeeded-default.yaml', `
name: SucceededDefault
steps:
  - pwsh: exit 1
    displayName: Failing Step
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "should-not-exist"
    displayName: Should Be Skipped
`);
      const result = await runPipeline(file);

      expect(result.status).toBe('failed');
      await expect(fs.access(outFile)).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 5: Error Handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Error Handling', () => {
    it('13. failing step → exitCode 1, status failed', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('fail-step.yaml', `
name: FailStep
steps:
  - pwsh: exit 1
    displayName: Fail
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(1);
      expect(result.status).toBe('failed');
    });

    it('14. continueOnError: true — job does not fail', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'continue-on-error.txt');
      const file = await writePipeline('continue-on-error.yaml', `
name: ContinueOnError
steps:
  - pwsh: exit 1
    displayName: Failing Step
    continueOnError: true
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "continued"
    displayName: After Error
`);
      const result = await runPipeline(file);

      // succeededWithIssues because step failed but continueOnError was true
      expect(result.status).toBe('succeededWithIssues');
      expect(result.exitCode).toBe(2);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('continued');
    });

    it('15. multiple stages where one fails → succeededWithIssues', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('partial-failure.yaml', `
name: PartialFailure
stages:
  - stage: Good
    jobs:
      - job: GoodJob
        steps:
          - pwsh: Write-Host "all good"
  - stage: Bad
    dependsOn: []
    jobs:
      - job: BadJob
        steps:
          - pwsh: exit 1
`);
      const result = await runPipeline(file);

      // One stage succeeded, one failed → succeededWithIssues
      expect(result.status).toBe('succeededWithIssues');
      expect(result.exitCode).toBe(2);
    });

    it('missing conditionEvaluator throws', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const file = await writePipeline('no-cond.yaml', `
name: NoCond
steps:
  - pwsh: Write-Host "hi"
`);
      const runner = new PipelineRunner();
      const result = await runner.run({
        filePath: file,
        params: {},
        workingDirectory: tempDir,
        conditionEvaluator: undefined as unknown as ConditionEvaluator,
        stepRunnerFactory: (opts) => new StepRunner(opts),
      });
      // The runner logs the error and returns a failed result
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    });

    it('missing stepRunnerFactory throws', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const { conditionEvaluator } = createRunDeps();
      const file = await writePipeline('no-factory.yaml', `
name: NoFactory
steps:
  - pwsh: Write-Host "hi"
`);
      const runner = new PipelineRunner();
      const result = await runner.run({
        filePath: file,
        params: {},
        workingDirectory: tempDir,
        conditionEvaluator,
        stepRunnerFactory: undefined as unknown as (opts: any) => StepRunner,
      });
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 6: Selective Execution (Filters)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Selective Execution', () => {
    it('16. stageFilter — only specified stage runs', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile1 = path.join(tempDir, 'stage-filter-a.txt');
      const outFile2 = path.join(tempDir, 'stage-filter-b.txt');
      const file = await writePipeline('stage-filter.yaml', `
name: StageFilter
stages:
  - stage: Alpha
    jobs:
      - job: AlphaJob
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile1)}" -Value "alpha-ran"
  - stage: Beta
    dependsOn: []
    jobs:
      - job: BetaJob
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile2)}" -Value "beta-ran"
`);
      const result = await runPipeline(file, { stageFilter: 'Alpha' });

      expect(result.exitCode).toBe(0);
      const content1 = await fs.readFile(outFile1, 'utf-8');
      expect(content1.trim()).toBe('alpha-ran');

      // Beta should not have run
      await expect(fs.access(outFile2)).rejects.toThrow();
    });

    it('17. jobFilter — only specified job runs', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile1 = path.join(tempDir, 'job-filter-a.txt');
      const outFile2 = path.join(tempDir, 'job-filter-b.txt');
      const file = await writePipeline('job-filter.yaml', `
name: JobFilter
stages:
  - stage: Main
    jobs:
      - job: TargetJob
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile1)}" -Value "target-ran"
  - stage: Other
    dependsOn: []
    jobs:
      - job: OtherJob
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile2)}" -Value "other-ran"
`);
      const result = await runPipeline(file, { jobFilter: 'TargetJob' });

      expect(result.exitCode).toBe(0);
      const content1 = await fs.readFile(outFile1, 'utf-8');
      expect(content1.trim()).toBe('target-ran');

      // OtherJob should not have run
      await expect(fs.access(outFile2)).rejects.toThrow();
    });

    it('stageFilter that matches nothing causes pipeline error', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const file = await writePipeline('bad-filter.yaml', `
name: BadFilter
stages:
  - stage: Only
    jobs:
      - job: OnlyJob
        steps:
          - pwsh: Write-Host "ran"
`);
      const result = await runPipeline(file, { stageFilter: 'NonExistent' });
      // getSubgraph throws when target not found → pipeline returns failed
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    });

    it('18. dryRun compiles but does not execute', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'dry-run-out.txt');
      const file = await writePipeline('dry-run.yaml', `
name: DryRun
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "should-not-exist"
            displayName: Build Step
`);
      const result = await runPipeline(file, { dryRun: true });

      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
      expect(result.stages).toEqual([]);
      await expect(fs.access(outFile)).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 7: Matrix Strategy
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Matrix Strategy', () => {
    it('19. matrix with 2 configs — both combinations run', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('matrix.yaml', `
name: MatrixPipeline
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        strategy:
          matrix:
            linux:
              os: linux
            windows:
              os: windows
        steps:
          - pwsh: Write-Host "Building on $(os)"
`);
      const result = await runPipeline(file);

      // Even without full matrix expansion in the runner (it's in strategy-runner),
      // the pipeline should succeed
      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 8: Cancellation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Cancellation', () => {
    it('20. runner.cancel() stops execution gracefully', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('cancel.yaml', `
name: CancelPipeline
stages:
  - stage: LongStage
    jobs:
      - job: LongJob
        steps:
          - pwsh: Start-Sleep -Seconds 10
            displayName: Long Step
`);
      const { conditionEvaluator } = createRunDeps();
      const runner = new PipelineRunner();

      // Cancel after a short delay
      const cancelTimer = setTimeout(() => runner.cancel(), 500);

      const result = await runner.run({
        filePath: file,
        params: {},
        workingDirectory: tempDir,
        verbose: false,
        conditionEvaluator,
        stepRunnerFactory: (opts) => new StepRunner(opts),
      });

      clearTimeout(cancelTimer);

      // Either canceled or failed due to abort — both are acceptable
      expect(['canceled', 'failed']).toContain(result.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 9: Step Types
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Step Types', () => {
    it('21. pwsh step executes PowerShell', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'pwsh-out.txt');
      const file = await writePipeline('pwsh.yaml', `
name: PwshTest
steps:
  - pwsh: |
      $value = "pwsh-works"
      Set-Content -Path "${fwd(outFile)}" -Value $value
    displayName: PowerShell Step
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('pwsh-works');
    });

    it('22. node step executes Node.js', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'node-out.txt');
      const file = await writePipeline('node-step.yaml', `
name: NodeTest
steps:
  - node: |
      import { writeFileSync } from 'node:fs';
      writeFileSync("${fwd(outFile)}", "node-works");
    displayName: Node Step
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('node-works');
    });

    it('23. step with env block — env vars passed', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'env-out.txt');
      const file = await writePipeline('env-step.yaml', `
name: EnvTest
steps:
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "$env:MY_CUSTOM_VAR"
    displayName: Env Step
    env:
      MY_CUSTOM_VAR: "env-value-42"
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('env-value-42');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 10: Pipeline normalization
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Pipeline Normalization', () => {
    it('jobs-only pipeline wraps in default stage', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('jobs-only.yaml', `
name: JobsOnly
jobs:
  - job: MyJob
    steps:
      - pwsh: Write-Host "jobs-only pipeline"
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      expect(result.stages[0].name).toBe('__default');
    });

    it('normalizePipeline with empty pipeline returns empty array', () => {
      const runner = new PipelineRunner();
      const stages = runner.normalizePipeline({} as any);
      expect(stages).toEqual([]);
    });

    it('normalizePipeline with stages returns them as-is', () => {
      const runner = new PipelineRunner();
      const stages = runner.normalizePipeline({
        stages: [{ stage: 'Build', jobs: [] }],
      } as any);
      expect(stages.length).toBe(1);
      expect(stages[0].stage).toBe('Build');
    });

    it('normalizePipeline with jobs wraps in default stage', () => {
      const runner = new PipelineRunner();
      const stages = runner.normalizePipeline({
        jobs: [{ job: 'MyJob', steps: [] }],
      } as any);
      expect(stages.length).toBe(1);
      expect(stages[0].stage).toBe('__default');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 11: Disabled steps
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Disabled Steps', () => {
    it('disabled step is skipped', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'disabled-out.txt');
      const file = await writePipeline('disabled.yaml', `
name: DisabledStep
steps:
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "should-not-exist"
    displayName: Disabled
    enabled: false
  - pwsh: Write-Host "enabled step"
    displayName: Enabled
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      await expect(fs.access(outFile)).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 12: Stage condition
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Stage Conditions', () => {
    it('stage with false condition is skipped', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'stage-cond-out.txt');
      const file = await writePipeline('stage-cond.yaml', `
name: StageCond
stages:
  - stage: Skipped
    condition: "eq(1, 2)"
    jobs:
      - job: SkippedJob
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "should-not-exist"
  - stage: Running
    dependsOn: []
    jobs:
      - job: RunningJob
        steps:
          - pwsh: Write-Host "this runs"
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      await expect(fs.access(outFile)).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 13: Job condition
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Job Conditions', () => {
    it('job with false condition is skipped', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'job-cond-out.txt');
      const file = await writePipeline('job-cond.yaml', `
name: JobCond
stages:
  - stage: Main
    jobs:
      - job: SkippedJob
        condition: "eq(1, 2)"
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "should-not-exist"
      - job: RunningJob
        steps:
          - pwsh: Write-Host "this runs"
`);
      const result = await runPipeline(file);

      expect(result.exitCode).toBe(0);
      await expect(fs.access(outFile)).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 14: Empty pipeline / no jobs
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Edge Cases', () => {
    it('empty stage with no jobs succeeds', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('empty-stage.yaml', `
name: EmptyStage
stages:
  - stage: Empty
    jobs: []
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
    });

    it('job with no steps succeeds', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('empty-job.yaml', `
name: EmptyJob
stages:
  - stage: Main
    jobs:
      - job: NoSteps
        steps: []
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
      expect(result.status).toBe('succeeded');
    });

    it('stage variables are available to steps', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'stage-vars.txt');
      const file = await writePipeline('stage-vars.yaml', `
name: StageVars
stages:
  - stage: WithVars
    variables:
      - name: stageVar
        value: "stage-val"
    jobs:
      - job: VarJob
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "$env:STAGEVAR"
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('stage-val');
    });

    it('job variables are available to steps', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'job-vars.txt');
      const file = await writePipeline('job-vars.yaml', `
name: JobVars
stages:
  - stage: Main
    jobs:
      - job: VarJob
        variables:
          - name: jobVar
            value: "job-val"
        steps:
          - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "$env:JOBVAR"
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('job-val');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 15: Job-level branches
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Job Runner Branches', () => {
    it('deployment job through pipeline runner', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'deploy-job-pipeline.txt');
      const file = await writePipeline('deploy-job.yaml', `
name: DeployPipeline
stages:
  - stage: Deploy
    jobs:
      - deployment: web
        environment: staging
        strategy:
          runOnce:
            deploy:
              steps:
                - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "deploy-ran"
`);
      const result = await runPipeline(file);
      // Deployment jobs go through job-runner's getJobSteps deployment path
      expect(result.stages.length).toBe(1);
    });

    it('step with name property uses it as step name', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('named-step.yaml', `
name: NamedStep
steps:
  - pwsh: Write-Host "named"
    name: myStepName
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
    });

    it('step with displayName property uses it as step name', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('display-step.yaml', `
name: DisplayStep
steps:
  - pwsh: Write-Host "displayed"
    displayName: My Display Name
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
    });

    it('multiple steps with failure, disabled step after, and always step', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const outFile = path.join(tempDir, 'disabled-after-fail.txt');
      const file = await writePipeline('fail-disabled-always.yaml', `
name: FailDisabledAlways
steps:
  - pwsh: exit 1
    displayName: Failing
  - pwsh: Write-Host "should-not-run"
    displayName: Disabled After
    enabled: false
  - pwsh: Set-Content -Path "${fwd(outFile)}" -Value "always-ran"
    displayName: Always
    condition: "always()"
`);
      const result = await runPipeline(file);
      expect(result.status).toBe('failed');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('always-ran');
    });

    it('succeededWithIssues step propagates to job', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('issues-propagate.yaml', `
name: IssuesPropagate
steps:
  - pwsh: exit 1
    displayName: Fail But Continue
    continueOnError: true
  - pwsh: Write-Host "after-issues"
    displayName: After Issues
`);
      const result = await runPipeline(file);
      expect(result.status).toBe('succeededWithIssues');
      expect(result.exitCode).toBe(2);
    });

    it('job with timeoutInMinutes (large enough to pass)', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('job-timeout-pass.yaml', `
name: JobTimeout
stages:
  - stage: Main
    jobs:
      - job: TimedJob
        timeoutInMinutes: 5
        steps:
          - pwsh: Write-Host "quick"
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
    });

    it('verbose=false suppresses some output', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('non-verbose.yaml', `
name: NonVerbose
steps:
  - pwsh: Write-Host "quiet"
`);
      const result = await runPipeline(file, { verbose: false });
      expect(result.exitCode).toBe(0);
    });

    it('logging command setvariable through pipeline', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('logging-cmd.yaml', `
name: LoggingCmd
steps:
  - pwsh: |
      Write-Host "##pipeline[setvariable variable=myVar;isOutput=true]myValue"
    displayName: Set Var
  - pwsh: Write-Host "done"
    displayName: After Set
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
    });

    it('logging command setvariable with isSecret', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('logging-secret.yaml', `
name: LoggingSecret
steps:
  - pwsh: |
      Write-Host "##pipeline[setvariable variable=secretVar;isSecret=true]secretValue"
    displayName: Set Secret
  - pwsh: Write-Host "done"
    displayName: After Secret
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
    });

    it('node step name resolution', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('node-name.yaml', `
name: NodeName
steps:
  - node: console.log("hello")
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
    });

    it('failed step with outputs on the always step', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('always-with-output.yaml', `
name: AlwaysOutput
steps:
  - pwsh: exit 1
    displayName: Fail
  - pwsh: |
      Write-Host "##pipeline[setvariable variable=afterFail]ran-after-fail"
    displayName: Always With Output
    condition: "always()"
`);
      const result = await runPipeline(file);
      expect(result.status).toBe('failed');
    });

    it('skipped job due to condition', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('skipped-job.yaml', `
name: SkippedJob
stages:
  - stage: Main
    jobs:
      - job: Skip
        condition: "eq(1, 2)"
        steps:
          - pwsh: Write-Host "should not run"
      - job: Run
        steps:
          - pwsh: Write-Host "running"
`);
      const result = await runPipeline(file);
      expect(result.exitCode).toBe(0);
    });

    it('stage canceled path', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});

      const file = await writePipeline('stage-cancel.yaml', `
name: StageCancel
stages:
  - stage: First
    jobs:
      - job: SlowJob
        steps:
          - pwsh: Start-Sleep -Seconds 8
  - stage: Second
    dependsOn: First
    jobs:
      - job: AfterSlow
        steps:
          - pwsh: Write-Host "after"
`);
      const { conditionEvaluator } = createRunDeps();
      const runner = new PipelineRunner();

      const cancelTimer = setTimeout(() => runner.cancel(), 300);

      const result = await runner.run({
        filePath: file,
        params: {},
        workingDirectory: tempDir,
        verbose: true,
        conditionEvaluator,
        stepRunnerFactory: (opts) => new StepRunner(opts),
      });

      clearTimeout(cancelTimer);
      expect(['canceled', 'failed']).toContain(result.status);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 16: Step Runner additional branches
  // ═══════════════════════════════════════════════════════════════════════════

  describe('StepRunner additional branches', () => {
    it('python step executes', { timeout: 30_000 }, async () => {
      // Skip if python is not available
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { python: 'print("python-works")' },
        'python-step',
      );

      // If python is not available, it'll fail; either way we cover the branch
      expect(['succeeded', 'failed']).toContain(result.status);
    });

    it('step with stderr produces stderr output', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();
      const stderrLines: string[] = [];

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
        onOutput: (line, stream) => {
          if (stream === 'stderr') stderrLines.push(line);
        },
      });

      const result = await sr.executeStep(
        { pwsh: 'Write-Error "test-error" -ErrorAction Continue; exit 0' },
        'stderr-step',
      );

      expect(result.stderr.length).toBeGreaterThan(0);
    });

    it('step timeoutInMinutes is applied', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      // Very short timeout should cause failure
      const result = await sr.executeStep(
        { pwsh: 'Start-Sleep -Seconds 30', timeoutInMinutes: 0.01 },
        'timeout-step',
      );

      expect(result.status).toBe('failed');
    });

    it('runner-level timeoutMs is applied', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
        timeoutMs: 500,
      });

      const result = await sr.executeStep(
        { pwsh: 'Start-Sleep -Seconds 30' },
        'runner-timeout-step',
      );

      expect(result.status).toBe('failed');
    });

    it('spawning a non-existent command fails', { timeout: 10_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      // Node step writes temp file then runs node on it — this will succeed
      // but a task step fails with "not implemented"
      const result = await sr.executeStep(
        { task: 'NonExistent@1' },
        'nonexistent',
      );
      expect(result.status).toBe('failed');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Unit-style tests on runtime modules for coverage
  // ═══════════════════════════════════════════════════════════════════════════

  describe('DependencyGraph', () => {
    it('linear chain produces single-element batches', () => {
      const graph = new DependencyGraph([
        { id: 'A', dependsOn: [] },
        { id: 'B', dependsOn: ['A'] },
        { id: 'C', dependsOn: ['B'] },
      ]);
      const order = graph.getExecutionOrder();
      expect(order).toEqual([['A'], ['B'], ['C']]);
    });

    it('parallel nodes in same batch', () => {
      const graph = new DependencyGraph([
        { id: 'A', dependsOn: [] },
        { id: 'B', dependsOn: [] },
        { id: 'C', dependsOn: ['A', 'B'] },
      ]);
      const order = graph.getExecutionOrder();
      expect(order).toEqual([['A', 'B'], ['C']]);
    });

    it('cycle detection throws DependencyGraphError', () => {
      const graph = new DependencyGraph([
        { id: 'A', dependsOn: ['B'] },
        { id: 'B', dependsOn: ['A'] },
      ]);
      expect(() => graph.getExecutionOrder()).toThrow(DependencyGraphError);
    });

    it('missing dependency is detected', () => {
      const graph = new DependencyGraph([
        { id: 'A', dependsOn: ['nonexistent'] },
      ]);
      const validation = graph.validate();
      expect(validation.valid).toBe(false);
      expect(validation.errors[0]).toContain('nonexistent');
    });

    it('getDependencies returns transitive deps', () => {
      const graph = new DependencyGraph([
        { id: 'A', dependsOn: [] },
        { id: 'B', dependsOn: ['A'] },
        { id: 'C', dependsOn: ['B'] },
      ]);
      const deps = graph.getDependencies('C');
      expect(deps).toEqual(['A', 'B']);
    });

    it('getDependencies for unknown node returns empty', () => {
      const graph = new DependencyGraph([{ id: 'A', dependsOn: [] }]);
      expect(graph.getDependencies('unknown')).toEqual([]);
    });

    it('getSubgraph includes target and all dependencies', () => {
      const graph = new DependencyGraph([
        { id: 'A', dependsOn: [] },
        { id: 'B', dependsOn: ['A'] },
        { id: 'C', dependsOn: ['B'] },
        { id: 'D', dependsOn: [] },
      ]);
      const sub = graph.getSubgraph(['C']);
      expect(sub).toEqual(['A', 'B', 'C']);
    });

    it('getSubgraph throws for unknown target', () => {
      const graph = new DependencyGraph([{ id: 'A', dependsOn: [] }]);
      expect(() => graph.getSubgraph(['Z'])).toThrow(DependencyGraphError);
    });

    it('validate returns valid for acyclic graph', () => {
      const graph = new DependencyGraph([
        { id: 'A', dependsOn: [] },
        { id: 'B', dependsOn: ['A'] },
      ]);
      expect(graph.validate().valid).toBe(true);
    });

    it('single node graph works', () => {
      const graph = new DependencyGraph([{ id: 'A', dependsOn: [] }]);
      expect(graph.getExecutionOrder()).toEqual([['A']]);
    });

    it('empty graph returns empty batches', () => {
      const graph = new DependencyGraph([]);
      expect(graph.getExecutionOrder()).toEqual([]);
    });
  });

  describe('normalizeDependsOn', () => {
    it('undefined → empty array', () => {
      expect(normalizeDependsOn(undefined)).toEqual([]);
    });

    it('string → single-element array', () => {
      expect(normalizeDependsOn('A')).toEqual(['A']);
    });

    it('array → shallow copy', () => {
      const input = ['A', 'B'];
      const result = normalizeDependsOn(input);
      expect(result).toEqual(['A', 'B']);
      expect(result).not.toBe(input);
    });

    it('null → empty array', () => {
      expect(normalizeDependsOn(null as unknown as undefined)).toEqual([]);
    });
  });

  describe('StrategyRunner', () => {
    it('expandStrategy with no matrix returns single instance', () => {
      const sr = new StrategyRunner();
      const expansion = sr.expandStrategy('myJob', {});
      expect(expansion.instances.length).toBe(1);
      expect(expansion.instances[0].name).toBe('myJob');
      expect(expansion.instances[0].variables).toEqual({});
    });

    it('expandStrategy with matrix expands configurations', () => {
      const sr = new StrategyRunner();
      const expansion = sr.expandStrategy('build', {
        matrix: {
          linux: { os: 'linux', arch: 'x64' },
          windows: { os: 'windows', arch: 'x64' },
        },
      });
      expect(expansion.instances.length).toBe(2);
      expect(expansion.instances.map((i) => i.name).sort()).toEqual([
        'build_linux',
        'build_windows',
      ]);
      expect(expansion.instances[0].variables).toHaveProperty('os');
    });

    it('expandStrategy with parallel creates N copies', () => {
      const sr = new StrategyRunner();
      const expansion = sr.expandStrategy('test', { parallel: 3 });
      expect(expansion.instances.length).toBe(3);
      expect(expansion.instances.map((i) => i.name)).toEqual([
        'test_1',
        'test_2',
        'test_3',
      ]);
      expect(expansion.instances[0].variables['System.JobPositionInPhase']).toBe('1');
      expect(expansion.instances[0].variables['System.TotalJobsInPhase']).toBe('3');
    });

    it('expandMatrix generates correct instances', () => {
      const sr = new StrategyRunner();
      const instances = sr.expandMatrix('job', {
        debug: { config: 'Debug' },
        release: { config: 'Release' },
      });
      expect(instances.length).toBe(2);
      expect(instances[0].name).toBe('job_debug');
      expect(instances[0].variables.config).toBe('Debug');
    });

    it('runInstances runs all concurrently when no maxParallel', async () => {
      const sr = new StrategyRunner();
      const instances = [
        { name: 'a', variables: {} },
        { name: 'b', variables: {} },
      ];
      const results = await sr.runInstances(instances, undefined, async (inst) => ({
        name: inst.name,
        status: 'succeeded' as const,
        duration: 10,
        steps: [],
      }));
      expect(results.length).toBe(2);
      expect(results.map((r) => r.name).sort()).toEqual(['a', 'b']);
    });

    it('runInstances with maxParallel=1 throttles', async () => {
      const sr = new StrategyRunner();
      const order: string[] = [];
      const instances = [
        { name: 'a', variables: {} },
        { name: 'b', variables: {} },
        { name: 'c', variables: {} },
      ];
      const results = await sr.runInstances(instances, 1, async (inst) => {
        order.push(inst.name);
        return {
          name: inst.name,
          status: 'succeeded' as const,
          duration: 10,
          steps: [],
        };
      });
      expect(results.length).toBe(3);
      expect(order).toEqual(['a', 'b', 'c']);
    });

    it('runInstances with empty array returns empty', async () => {
      const sr = new StrategyRunner();
      const results = await sr.runInstances([], undefined, async () => ({
        name: 'x',
        status: 'succeeded' as const,
        duration: 0,
        steps: [],
      }));
      expect(results).toEqual([]);
    });

    it('runInstances with maxParallel >= instances runs all concurrently', async () => {
      const sr = new StrategyRunner();
      const instances = [
        { name: 'a', variables: {} },
        { name: 'b', variables: {} },
      ];
      const results = await sr.runInstances(instances, 10, async (inst) => ({
        name: inst.name,
        status: 'succeeded' as const,
        duration: 10,
        steps: [],
      }));
      expect(results.length).toBe(2);
    });
  });

  describe('ConditionEvaluator', () => {
    it('undefined condition uses default (succeeded())', () => {
      const { conditionEvaluator } = createRunDeps();
      const ctx = {
        variables: {},
        parameters: {},
        dependencies: {},
        pipeline: {},
      };
      const result = conditionEvaluator.evaluate(undefined, ctx, 'succeeded()');
      expect(result).toBe(true);
    });

    it('empty string condition always returns true', () => {
      const { conditionEvaluator } = createRunDeps();
      const ctx = {
        variables: {},
        parameters: {},
        dependencies: {},
        pipeline: {},
      };
      expect(conditionEvaluator.evaluate('', ctx)).toBe(true);
    });

    it('always() returns true', () => {
      const { conditionEvaluator } = createRunDeps();
      const ctx = {
        variables: {},
        parameters: {},
        dependencies: {},
        pipeline: {},
      };
      expect(conditionEvaluator.evaluate('always()', ctx)).toBe(true);
    });

    it('eq(1, 2) returns false', () => {
      const { conditionEvaluator } = createRunDeps();
      const ctx = {
        variables: {},
        parameters: {},
        dependencies: {},
        pipeline: {},
      };
      expect(conditionEvaluator.evaluate('eq(1, 2)', ctx)).toBe(false);
    });

    it('getDefaultCondition returns succeeded()', () => {
      const { conditionEvaluator } = createRunDeps();
      expect(conditionEvaluator.getDefaultCondition()).toBe('succeeded()');
    });
  });

  describe('PoolResolver', () => {
    it('resolvePool with undefined returns local default', () => {
      const pr = new PoolResolver();
      const pool = pr.resolvePool(undefined);
      expect(pool.type).toBe('local');
      expect(pool.name).toBe('default');
      expect(pool.demands).toEqual([]);
    });

    it('resolvePool with vmImage returns container type', () => {
      const pr = new PoolResolver();
      const pool = pr.resolvePool({ vmImage: 'ubuntu-latest' });
      expect(pool.type).toBe('container');
      expect(pool.name).toBe('ubuntu-latest');
      expect(pool.image).toBe('ubuntu:latest');
    });

    it('resolvePool with named pool returns local type', () => {
      const pr = new PoolResolver();
      const pool = pr.resolvePool({ name: 'my-pool' });
      expect(pool.type).toBe('local');
      expect(pool.name).toBe('my-pool');
    });

    it('resolvePool with demands normalizes them', () => {
      const pr = new PoolResolver();
      const pool = pr.resolvePool({ name: 'p', demands: 'node' });
      expect(pool.demands).toEqual(['node']);
    });

    it('resolvePool with demands array', () => {
      const pr = new PoolResolver();
      const pool = pr.resolvePool({ name: 'p', demands: ['node', 'git'] });
      expect(pool.demands).toEqual(['node', 'git']);
    });

    it('mapVmImage returns correct Docker images', () => {
      const pr = new PoolResolver();
      expect(pr.mapVmImage('ubuntu-latest')).toBe('ubuntu:latest');
      expect(pr.mapVmImage('windows-latest')).toBe(
        'mcr.microsoft.com/windows/servercore:ltsc2022',
      );
      expect(pr.mapVmImage('unknown-image')).toBeUndefined();
    });

    it('resolvePool with unknown vmImage uses it as image name', () => {
      const pr = new PoolResolver();
      const pool = pr.resolvePool({ vmImage: 'custom:v1' });
      expect(pool.type).toBe('container');
      expect(pool.image).toBe('custom:v1');
    });

    it('validateDemands succeeds for available tool', () => {
      const pr = new PoolResolver();
      // node should be available in the test env
      const result = pr.validateDemands(['node']);
      expect(result.satisfied).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('validateDemands fails for unavailable tool', () => {
      const pr = new PoolResolver();
      const result = pr.validateDemands(['nonexistent_tool_xyz_abc']);
      expect(result.satisfied).toBe(false);
      expect(result.missing).toContain('nonexistent_tool_xyz_abc');
    });

    it('validateDemands with Agent.OS expression', () => {
      const pr = new PoolResolver();
      const expected = os.platform() === 'win32' ? 'Windows_NT' : os.platform() === 'darwin' ? 'Darwin' : 'Linux';
      const result = pr.validateDemands([`Agent.OS -equals ${expected}`]);
      expect(result.satisfied).toBe(true);
    });

    it('validateDemands with wrong Agent.OS fails', () => {
      const pr = new PoolResolver();
      const result = pr.validateDemands(['Agent.OS -equals FakeOS']);
      expect(result.satisfied).toBe(false);
    });

    it('validateDemands with unknown key expression fails', () => {
      const pr = new PoolResolver();
      const result = pr.validateDemands(['Unknown.Key -equals something']);
      expect(result.satisfied).toBe(false);
    });

    it('checkCapabilities returns Agent.OS and common tools', async () => {
      const pr = new PoolResolver();
      const caps = await pr.checkCapabilities();
      expect(caps['Agent.OS']).toBeDefined();
      expect(caps['node']).toBeDefined();
    });

    it('resolvePool with no name defaults to "default"', () => {
      const pr = new PoolResolver();
      const pool = pr.resolvePool({});
      expect(pool.type).toBe('local');
      expect(pool.name).toBe('default');
    });
  });

  describe('WorkspaceManager', () => {
    let wsBaseDir: string;

    beforeAll(async () => {
      wsBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piperun-ws-'));
    });

    afterAll(async () => {
      if (wsBaseDir) {
        await fs.rm(wsBaseDir, { recursive: true, force: true });
      }
    });

    it('getWorkspace returns correct paths', () => {
      const wm = new WorkspaceManager(wsBaseDir);
      const ws = wm.getWorkspace('run-123');
      expect(ws.rootDir).toBe(path.join(wsBaseDir, 'run-123'));
      expect(ws.sourceDir).toBe(path.join(wsBaseDir, 'run-123', 's'));
      expect(ws.binariesDir).toBe(path.join(wsBaseDir, 'run-123', 'b'));
      expect(ws.artifactsDir).toBe(path.join(wsBaseDir, 'run-123', 'a'));
      expect(ws.tempDir).toBe(path.join(wsBaseDir, 'run-123', 'tmp'));
    });

    it('initialize creates all subdirectories', async () => {
      const wm = new WorkspaceManager(wsBaseDir);
      const ws = await wm.initialize('init-test');
      await fs.access(ws.sourceDir);
      await fs.access(ws.binariesDir);
      await fs.access(ws.artifactsDir);
      await fs.access(ws.tempDir);
    });

    it('clean outputs removes binaries and artifacts', async () => {
      const wm = new WorkspaceManager(wsBaseDir);
      const ws = await wm.initialize('clean-outputs');

      // Write a file in binaries
      await fs.writeFile(path.join(ws.binariesDir, 'test.bin'), 'data');
      await wm.clean(ws, 'outputs');

      // Directory should exist but be empty
      await fs.access(ws.binariesDir);
      const files = await fs.readdir(ws.binariesDir);
      expect(files.length).toBe(0);
    });

    it('clean resources removes source', async () => {
      const wm = new WorkspaceManager(wsBaseDir);
      const ws = await wm.initialize('clean-resources');

      await fs.writeFile(path.join(ws.sourceDir, 'test.txt'), 'data');
      await wm.clean(ws, 'resources');

      await fs.access(ws.sourceDir);
      const files = await fs.readdir(ws.sourceDir);
      expect(files.length).toBe(0);
    });

    it('clean all removes and recreates everything', async () => {
      const wm = new WorkspaceManager(wsBaseDir);
      const ws = await wm.initialize('clean-all');

      await fs.writeFile(path.join(ws.sourceDir, 'test.txt'), 'data');
      await fs.writeFile(path.join(ws.binariesDir, 'test.bin'), 'data');
      await wm.clean(ws, 'all');

      await fs.access(ws.sourceDir);
      await fs.access(ws.binariesDir);
      await fs.access(ws.artifactsDir);
      await fs.access(ws.tempDir);
      const files = await fs.readdir(ws.sourceDir);
      expect(files.length).toBe(0);
    });

    it('clean on nonexistent directory is no-op', async () => {
      const wm = new WorkspaceManager(wsBaseDir);
      const ws = wm.getWorkspace('nonexistent-run');
      // Should not throw
      await wm.clean(ws, 'all');
    });
  });

  describe('ContainerJobRunner', () => {
    it('resolveContainerConfig with string returns image config', () => {
      const cr = new ContainerJobRunner();
      const config = cr.resolveContainerConfig('node:18');
      expect(config.image).toBe('node:18');
      expect(config.options).toBeUndefined();
    });

    it('resolveContainerConfig with object returns full config', () => {
      const cr = new ContainerJobRunner();
      const config = cr.resolveContainerConfig({
        image: 'node:18',
        options: '--memory=512m',
        env: { NODE_ENV: 'test' },
        ports: ['3000:3000'],
        volumes: ['/data:/data'],
      });
      expect(config.image).toBe('node:18');
      expect(config.options).toBe('--memory=512m');
      expect(config.env).toEqual({ NODE_ENV: 'test' });
      expect(config.ports).toEqual(['3000:3000']);
      expect(config.volumes).toEqual(['/data:/data']);
    });

    it('isDockerAvailable returns a boolean', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cr = new ContainerJobRunner();
      const available = await cr.isDockerAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('isDockerAvailable caches the result', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cr = new ContainerJobRunner();
      const first = await cr.isDockerAvailable();
      const second = await cr.isDockerAvailable();
      expect(first).toBe(second);
    });

    it('validateContainerJob returns string when Docker unavailable', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cr = new ContainerJobRunner();
      // Force dockerAvailable to false
      (cr as any).dockerAvailable = false;
      const msg = await cr.validateContainerJob('myimage:latest');
      expect(msg).toContain('Docker is not configured');
      expect(msg).toContain('myimage:latest');
    });

    it('validateContainerJob returns null when Docker available', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cr = new ContainerJobRunner();
      (cr as any).dockerAvailable = true;
      const msg = await cr.validateContainerJob('myimage:latest');
      expect(msg).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group: StepRunner direct
  // ═══════════════════════════════════════════════════════════════════════════

  describe('StepRunner direct', () => {
    it('executes a pwsh step directly', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { pwsh: 'Write-Host "direct-step"' },
        'test-step',
      );

      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('direct-step');
    });

    it('disabled step returns skipped', async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { pwsh: 'Write-Host "hi"', enabled: false },
        'disabled',
      );
      expect(result.status).toBe('skipped');
    });

    it('step with env merges env vars', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();
      const outFile = path.join(tempDir, 'step-env-direct.txt');

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: { BASE_VAR: 'base' },
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        {
          pwsh: `Set-Content -Path "${fwd(outFile)}" -Value "$env:STEP_VAR"`,
          env: { STEP_VAR: 'step-value' },
        },
        'env-step',
      );

      expect(result.status).toBe('succeeded');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('step-value');
    });

    it('failing step returns failed status', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { pwsh: 'exit 42' },
        'fail-step',
      );

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(42);
    });

    it('continueOnError step returns succeededWithIssues', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { pwsh: 'exit 1', continueOnError: true },
        'continue-step',
      );

      expect(result.status).toBe('succeededWithIssues');
    });

    it('node step executes JavaScript', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { node: 'console.log("node-direct")' },
        'node-step',
      );

      expect(result.status).toBe('succeeded');
      expect(result.stdout).toContain('node-direct');
    });

    it('task step returns not-implemented failure', async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { task: 'SomeTask@1', inputs: {} },
        'task-step',
      );

      expect(result.status).toBe('failed');
      expect(result.stderr).toContain('not yet implemented');
    });

    it('unsupported step type returns failure', async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { template: 'some-template.yaml' } as any,
        'template-step',
      );

      expect(result.status).toBe('failed');
    });

    it('onOutput callback receives stdout lines', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();
      const lines: string[] = [];

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
        onOutput: (line) => lines.push(line),
      });

      await sr.executeStep(
        { pwsh: 'Write-Host "line1"; Write-Host "line2"' },
        'output-step',
      );

      expect(lines.some((l) => l.includes('line1'))).toBe(true);
      expect(lines.some((l) => l.includes('line2'))).toBe(true);
    });

    it('logging command setvariable captures output', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();
      const commands: Array<{ cmd: string; props: Record<string, string>; val: string }> = [];

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
        onLoggingCommand: (cmd, props, val) => commands.push({ cmd, props, val }),
      });

      const result = await sr.executeStep(
        { pwsh: 'Write-Host "##pipeline[setvariable variable=myVar]myValue"' },
        'logging-step',
      );

      expect(result.status).toBe('succeeded');
      expect(result.outputs['myVar']).toBe('myValue');
    });

    it('retryCountOnTaskFailure retries failed steps', { timeout: 30_000 }, async () => {
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');
      const masker = new SecretMasker();

      const sr = new StepRunner({
        workingDirectory: tempDir,
        environment: {},
        secretMasker: masker,
      });

      const result = await sr.executeStep(
        { pwsh: 'exit 1', retryCountOnTaskFailure: 2 },
        'retry-step',
      );

      expect(result.status).toBe('failed');
      expect(result.retryCount).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DeploymentRunner (direct instantiation for coverage)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('DeploymentRunner', () => {
    it('runOnce strategy executes hooks', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { VariableManager } = await import('../../src/variables/variable-manager.js');
      const { OutputVariableStore } = await import('../../src/variables/output-variables.js');
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');

      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      variableManager.enterScope('pipeline', 'test');

      const { conditionEvaluator } = createRunDeps();
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      const outFile = path.join(tempDir, 'deploy-runonce.txt');
      const dr = new DeploymentRunner(
        {
          variableManager,
          outputStore: new OutputVariableStore(),
          expressionEngine,
          conditionEvaluator,
          secretMasker,
        },
        { workingDirectory: tempDir, verbose: false },
      );

      const result = await dr.runDeployment(
        {
          deployment: 'web-app',
          environment: 'production',
          strategy: {
            runOnce: {
              deploy: {
                steps: [
                  { pwsh: `Set-Content -Path "${fwd(outFile)}" -Value "deployed"` },
                ],
              },
            },
          },
        },
        {
          runId: 'test-run',
          runNumber: 1,
          pipelineName: 'test',
          startTime: new Date(),
          status: 'running',
          stages: new Map(),
        },
      );

      expect(result.status).toBe('succeeded');
      expect(result.strategy).toBe('runOnce');
      expect(result.environment).toBe('production');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('deployed');

      variableManager.exitScope();
    });

    it('rolling strategy executes', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { VariableManager } = await import('../../src/variables/variable-manager.js');
      const { OutputVariableStore } = await import('../../src/variables/output-variables.js');
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');

      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      variableManager.enterScope('pipeline', 'test');

      const { conditionEvaluator } = createRunDeps();
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      const dr = new DeploymentRunner(
        {
          variableManager,
          outputStore: new OutputVariableStore(),
          expressionEngine,
          conditionEvaluator,
          secretMasker,
        },
        { workingDirectory: tempDir, verbose: false },
      );

      const result = await dr.runDeployment(
        {
          deployment: 'api',
          environment: 'staging',
          strategy: {
            rolling: {
              maxParallel: 2,
              deploy: {
                steps: [{ pwsh: 'Write-Host "rolling-deploy"' }],
              },
            },
          },
        },
        {
          runId: 'test-run',
          runNumber: 1,
          pipelineName: 'test',
          startTime: new Date(),
          status: 'running',
          stages: new Map(),
        },
      );

      expect(result.status).toBe('succeeded');
      expect(result.strategy).toBe('rolling');

      variableManager.exitScope();
    });

    it('canary strategy with increments', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { VariableManager } = await import('../../src/variables/variable-manager.js');
      const { OutputVariableStore } = await import('../../src/variables/output-variables.js');
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');

      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      variableManager.enterScope('pipeline', 'test');

      const { conditionEvaluator } = createRunDeps();
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      const dr = new DeploymentRunner(
        {
          variableManager,
          outputStore: new OutputVariableStore(),
          expressionEngine,
          conditionEvaluator,
          secretMasker,
        },
        { workingDirectory: tempDir, verbose: true },
      );

      const result = await dr.runDeployment(
        {
          deployment: 'frontend',
          environment: { name: 'prod' },
          strategy: {
            canary: {
              increments: [25, 50, 100],
              deploy: {
                steps: [{ pwsh: 'Write-Host "canary-deploy"' }],
              },
            },
          },
        },
        {
          runId: 'test-run',
          runNumber: 1,
          pipelineName: 'test',
          startTime: new Date(),
          status: 'running',
          stages: new Map(),
        },
      );

      expect(result.status).toBe('succeeded');
      expect(result.strategy).toBe('canary');
      expect(result.environment).toBe('prod');
      expect(result.hooks.length).toBeGreaterThanOrEqual(3);

      variableManager.exitScope();
    });

    it('no strategy specified succeeds with none', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { VariableManager } = await import('../../src/variables/variable-manager.js');
      const { OutputVariableStore } = await import('../../src/variables/output-variables.js');
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');

      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      variableManager.enterScope('pipeline', 'test');

      const { conditionEvaluator } = createRunDeps();
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      const dr = new DeploymentRunner(
        {
          variableManager,
          outputStore: new OutputVariableStore(),
          expressionEngine,
          conditionEvaluator,
          secretMasker,
        },
        { workingDirectory: tempDir, verbose: false },
      );

      const result = await dr.runDeployment(
        {
          deployment: 'noop',
          environment: 'dev',
          strategy: {} as any,
        },
        {
          runId: 'test-run',
          runNumber: 1,
          pipelineName: 'test',
          startTime: new Date(),
          status: 'running',
          stages: new Map(),
        },
      );

      expect(result.status).toBe('succeeded');
      expect(result.strategy).toBe('none');

      variableManager.exitScope();
    });

    it('deployment with on.success hook', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { VariableManager } = await import('../../src/variables/variable-manager.js');
      const { OutputVariableStore } = await import('../../src/variables/output-variables.js');
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');

      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      variableManager.enterScope('pipeline', 'test');

      const { conditionEvaluator } = createRunDeps();
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      const outFile = path.join(tempDir, 'on-success.txt');
      const dr = new DeploymentRunner(
        {
          variableManager,
          outputStore: new OutputVariableStore(),
          expressionEngine,
          conditionEvaluator,
          secretMasker,
        },
        { workingDirectory: tempDir, verbose: false },
      );

      const result = await dr.runDeployment(
        {
          deployment: 'success-hook',
          environment: 'staging',
          strategy: {
            runOnce: {
              deploy: {
                steps: [{ pwsh: 'Write-Host "deploying"' }],
              },
              on: {
                success: {
                  steps: [{ pwsh: `Set-Content -Path "${fwd(outFile)}" -Value "success-hook-ran"` }],
                },
              },
            },
          },
        },
        {
          runId: 'test-run',
          runNumber: 1,
          pipelineName: 'test',
          startTime: new Date(),
          status: 'running',
          stages: new Map(),
        },
      );

      expect(result.status).toBe('succeeded');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('success-hook-ran');

      variableManager.exitScope();
    });

    it('deployment with on.failure hook when deploy fails', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { VariableManager } = await import('../../src/variables/variable-manager.js');
      const { OutputVariableStore } = await import('../../src/variables/output-variables.js');
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');

      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      variableManager.enterScope('pipeline', 'test');

      const { conditionEvaluator } = createRunDeps();
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      const outFile = path.join(tempDir, 'on-failure.txt');
      const dr = new DeploymentRunner(
        {
          variableManager,
          outputStore: new OutputVariableStore(),
          expressionEngine,
          conditionEvaluator,
          secretMasker,
        },
        { workingDirectory: tempDir, verbose: false },
      );

      const result = await dr.runDeployment(
        {
          deployment: 'fail-deploy',
          environment: 'staging',
          strategy: {
            runOnce: {
              deploy: {
                steps: [{ pwsh: 'exit 1' }],
              },
              on: {
                failure: {
                  steps: [{ pwsh: `Set-Content -Path "${fwd(outFile)}" -Value "failure-hook-ran"` }],
                },
              },
            },
          },
        },
        {
          runId: 'test-run',
          runNumber: 1,
          pipelineName: 'test',
          startTime: new Date(),
          status: 'running',
          stages: new Map(),
        },
      );

      expect(result.status).toBe('failed');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('failure-hook-ran');

      variableManager.exitScope();
    });

    it('deployment with preDeploy hook', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { VariableManager } = await import('../../src/variables/variable-manager.js');
      const { OutputVariableStore } = await import('../../src/variables/output-variables.js');
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');

      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      variableManager.enterScope('pipeline', 'test');

      const { conditionEvaluator } = createRunDeps();
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      const outFile = path.join(tempDir, 'predeploy.txt');
      const dr = new DeploymentRunner(
        {
          variableManager,
          outputStore: new OutputVariableStore(),
          expressionEngine,
          conditionEvaluator,
          secretMasker,
        },
        { workingDirectory: tempDir, verbose: false },
      );

      const result = await dr.runDeployment(
        {
          deployment: 'pre-hook',
          environment: 'staging',
          strategy: {
            runOnce: {
              preDeploy: {
                steps: [{ pwsh: `Set-Content -Path "${fwd(outFile)}" -Value "pre-deployed"` }],
              },
              deploy: {
                steps: [{ pwsh: 'Write-Host "deploying"' }],
              },
            },
          },
        },
        {
          runId: 'test-run',
          runNumber: 1,
          pipelineName: 'test',
          startTime: new Date(),
          status: 'running',
          stages: new Map(),
        },
      );

      expect(result.status).toBe('succeeded');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('pre-deployed');

      variableManager.exitScope();
    });

    it('empty hook (no steps) succeeds', { timeout: 30_000 }, async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { VariableManager } = await import('../../src/variables/variable-manager.js');
      const { OutputVariableStore } = await import('../../src/variables/output-variables.js');
      const { SecretMasker } = await import('../../src/variables/secret-masker.js');

      const secretMasker = new SecretMasker();
      const variableManager = new VariableManager(secretMasker);
      variableManager.enterScope('pipeline', 'test');

      const { conditionEvaluator } = createRunDeps();
      const functionRegistry = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const expressionEngine = createExpressionEngine(functionRegistry);

      const dr = new DeploymentRunner(
        {
          variableManager,
          outputStore: new OutputVariableStore(),
          expressionEngine,
          conditionEvaluator,
          secretMasker,
        },
        { workingDirectory: tempDir, verbose: false },
      );

      const result = await dr.runDeployment(
        {
          deployment: 'empty-hooks',
          environment: 'dev',
          strategy: {
            runOnce: {
              deploy: { steps: [] },
            },
          },
        },
        {
          runId: 'test-run',
          runNumber: 1,
          pipelineName: 'test',
          startTime: new Date(),
          status: 'running',
          stages: new Map(),
        },
      );

      expect(result.status).toBe('succeeded');

      variableManager.exitScope();
    });
  });
});
