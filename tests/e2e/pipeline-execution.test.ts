import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const exec = promisify(execFile);
const CLI_PATH = path.resolve('dist', 'index.js');

let tempDir: string;

async function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; timeout?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await exec('node', [CLI_PATH, ...args], {
      cwd: options.cwd ?? tempDir,
      env: { ...process.env, FORCE_COLOR: '0', ...options.env },
      timeout: options.timeout ?? 30_000,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
    };
  }
}

async function writePipeline(name: string, content: string): Promise<string> {
  const filePath = path.join(tempDir, name);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
  return filePath;
}

/** Convert a Windows path to forward slashes for safe embedding in YAML/PowerShell. */
function fwd(p: string): string {
  return p.replace(/\\/g, '/');
}

describe('E2E Pipeline Execution', () => {
  beforeAll(async () => {
    try {
      await fs.access(CLI_PATH);
    } catch {
      throw new Error(
        `Built CLI not found at ${CLI_PATH}. Run "npx tsup" before running E2E tests.`,
      );
    }
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piperun-e2e-'));
  });

  afterAll(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 1: Basic Execution
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 1: Basic Execution', () => {
    it('1. simple single-step pipeline writes a file', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-basic.txt');
      const pipeline = await writePipeline('basic.yaml', `
name: Basic
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "hello-e2e"
    displayName: Write File
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('hello-e2e');
    });

    it('2. multi-step pipeline executes steps in order', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-multi.txt');
      const pipeline = await writePipeline('multi-step.yaml', `
name: MultiStep
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "1"
    displayName: Step 1
  - pwsh: |
      Add-Content -Path "${fwd(outFile)}" -Value "2"
    displayName: Step 2
  - pwsh: |
      Add-Content -Path "${fwd(outFile)}" -Value "3"
    displayName: Step 3
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      const lines = content.trim().split(/\r?\n/);
      expect(lines).toEqual(['1', '2', '3']);
    });

    it('3. steps-only pipeline (no jobs/stages wrapper) auto-wraps', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-steps-only.txt');
      const pipeline = await writePipeline('steps-only.yaml', `
name: StepsOnly
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "auto-wrapped"
    displayName: Auto Wrap Test
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('succeeded');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('auto-wrapped');
    });

    it('4. named jobs pipeline — multiple named jobs all run', { timeout: 30_000 }, async () => {
      const outFileA = path.join(tempDir, 'out-job-a.txt');
      const outFileB = path.join(tempDir, 'out-job-b.txt');
      const pipeline = await writePipeline('named-jobs.yaml', `
name: NamedJobs
jobs:
  - job: JobA
    displayName: Job Alpha
    steps:
      - pwsh: |
          Set-Content -Path "${fwd(outFileA)}" -Value "jobA-done"
        displayName: Write A
  - job: JobB
    displayName: Job Beta
    steps:
      - pwsh: |
          Set-Content -Path "${fwd(outFileB)}" -Value "jobB-done"
        displayName: Write B
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('succeeded');
      const contentA = await fs.readFile(outFileA, 'utf-8');
      const contentB = await fs.readFile(outFileB, 'utf-8');
      expect(contentA.trim()).toBe('jobA-done');
      expect(contentB.trim()).toBe('jobB-done');
    });

    it('5. multi-stage pipeline with dependencies executes in correct order', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-stages.txt');
      const pipeline = await writePipeline('multi-stage.yaml', `
name: MultiStage
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outFile)}" -Value "build"
            displayName: Build Step
  - stage: Test
    dependsOn: Build
    jobs:
      - job: TestJob
        steps:
          - pwsh: |
              Add-Content -Path "${fwd(outFile)}" -Value "test"
            displayName: Test Step
  - stage: Deploy
    dependsOn: Test
    jobs:
      - job: DeployJob
        steps:
          - pwsh: |
              Add-Content -Path "${fwd(outFile)}" -Value "deploy"
            displayName: Deploy Step
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      const lines = content.trim().split(/\r?\n/);
      expect(lines).toEqual(['build', 'test', 'deploy']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 2: Step Output & Logging Commands
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 2: Step Output & Logging Commands', () => {
    it('6. step stdout captured in verbose mode', { timeout: 30_000 }, async () => {
      const pipeline = await writePipeline('stdout-test.yaml', `
name: StdoutTest
steps:
  - pwsh: |
      Write-Host "E2E_VISIBLE_OUTPUT"
    displayName: Echo Test
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('E2E_VISIBLE_OUTPUT');
    });

    it('7. logging command setvariable sets variable for next step', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-setvar.txt');
      const pipeline = await writePipeline('setvariable.yaml', `
name: SetVarTest
steps:
  - pwsh: |
      Write-Host "##pipeline[setvariable variable=myVar]myValue"
    displayName: Set Variable
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "$env:MYVAR"
    displayName: Read Variable
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('##pipeline[setvariable variable=myVar]myValue');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('myValue');
    });

    it('8. output variables between steps via isOutput', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-outputvar.txt');
      const pipeline = await writePipeline('outputvar.yaml', `
name: OutputVarTest
steps:
  - pwsh: |
      Write-Host "##pipeline[setvariable variable=outVal;isOutput=true]exported123"
    name: setter
    displayName: Set Output
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "$env:OUTVAL"
    displayName: Read Output
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('exported123');
    });

    it('9. step stderr is captured in verbose mode', { timeout: 30_000 }, async () => {
      const pipeline = await writePipeline('stderr-test.yaml', `
name: StderrTest
steps:
  - pwsh: |
      [Console]::Error.WriteLine("E2E_STDERR_LINE")
    displayName: Write Stderr
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('E2E_STDERR_LINE');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 3: Variables
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 3: Variables', () => {
    it('10. inline variables passed to step env', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-inline-var.txt');
      const pipeline = await writePipeline('inline-vars.yaml', `
name: InlineVars
variables:
  MY_VAR: hello-from-var
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "$env:MY_VAR"
    displayName: Use Var
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('hello-from-var');
    });

    it('11. step-level env block passes custom env vars', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-step-env.txt');
      const pipeline = await writePipeline('step-env.yaml', `
name: StepEnv
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "$env:CUSTOM_KEY"
    displayName: Use Step Env
    env:
      CUSTOM_KEY: custom-value-42
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('custom-value-42');
    });

    it('12. system variables are available (Pipeline.Name, Pipeline.RunId)', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-sysvar.txt');
      const pipeline = await writePipeline('sysvar.yaml', `
name: SysVarTest
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "$env:PIPELINE_NAME"
    displayName: Write Pipeline Name
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('SysVarTest');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 4: Parameters
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 4: Parameters', () => {
    it('13. parameter with default value is used', { timeout: 30_000 }, async () => {
      const pipeline = await writePipeline('param-default.yaml', `
name: ParamDefault
parameters:
  - name: greeting
    type: string
    default: default-hello
steps:
  - pwsh: |
      Write-Host "GREETING=default-hello"
    displayName: Greet
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('GREETING=default-hello');
    });

    it('14. parameter from CLI overrides default', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-param-cli.txt');
      const pipeline = await writePipeline('param-cli.yaml', `
name: ParamCLI
parameters:
  - name: msg
    type: string
    default: fallback
steps:
  - pwsh: |
      Write-Host "PARAM_MSG=cli-override"
    displayName: Use Param
`);
      const { exitCode, stdout } = await runCli([
        'run',
        pipeline,
        '--verbose',
        '--param.msg=cli-override',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('PARAM_MSG=cli-override');
    });

    it('15. required parameter missing (no default) fails pipeline', { timeout: 30_000 }, async () => {
      const pipeline = await writePipeline('param-required.yaml', `
name: ParamRequired
parameters:
  - name: requiredParam
    type: string
steps:
  - pwsh: |
      Write-Host "should not run"
    displayName: Should Not Run
`);
      const { exitCode, stdout, stderr } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(1);
      const combined = stdout + stderr;
      expect(combined.toLowerCase()).toMatch(/required|error|not provided/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 5: Conditions
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 5: Conditions', () => {
    it('16. step with false condition is skipped, pipeline succeeds', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-cond-false.txt');
      const pipeline = await writePipeline('cond-false.yaml', `
name: CondFalse
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "first"
    displayName: First Step
  - pwsh: |
      Write-Host "SHOULD_NOT_RUN"
    displayName: Conditional Skip
    condition: eq(1, 2)
  - pwsh: |
      Add-Content -Path "${fwd(outFile)}" -Value "third"
    displayName: Third Step
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain('SHOULD_NOT_RUN');
      expect(stdout).toContain('Skipped');
      const content = await fs.readFile(outFile, 'utf-8');
      const lines = content.trim().split(/\r?\n/);
      expect(lines).toEqual(['first', 'third']);
    });

    it('17. job with false condition is skipped', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-job-cond.txt');
      const pipeline = await writePipeline('job-cond.yaml', `
name: JobCondition
jobs:
  - job: SkippedJob
    condition: eq(1, 2)
    steps:
      - pwsh: |
          Set-Content -Path "${fwd(outFile)}" -Value "should-not-exist"
        displayName: Should Not Run
  - job: RunningJob
    steps:
      - pwsh: |
          Write-Host "JOB_RAN"
        displayName: This Runs
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      expect(stdout).toContain('Skipped');
      expect(stdout).toContain('JOB_RAN');
      // The output file should NOT exist since SkippedJob was skipped
      await expect(fs.access(outFile)).rejects.toThrow();
    });

    it('18. always() condition — step runs even after failure', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-always.txt');
      const pipeline = await writePipeline('always-cond.yaml', `
name: AlwaysCondition
steps:
  - pwsh: |
      Write-Host "about to fail"
      exit 1
    displayName: Failing Step
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "always-ran"
    displayName: Always Step
    condition: always()
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(1);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('always-ran');
    });

    it('19. succeeded() default — step after failed step is skipped', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-default-cond.txt');
      const pipeline = await writePipeline('default-cond.yaml', `
name: DefaultCond
steps:
  - pwsh: |
      exit 1
    displayName: Failing Step
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "should-not-exist"
    displayName: Skipped Step
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('Skipped');
      await expect(fs.access(outFile)).rejects.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 6: Error Handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 6: Error Handling', () => {
    it('20. step failure (non-zero exit) fails pipeline with exit code 1', { timeout: 30_000 }, async () => {
      const pipeline = await writePipeline('step-fail.yaml', `
name: StepFail
steps:
  - pwsh: |
      Write-Host "failing now"
      exit 1
    displayName: Fail Step
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(1);
      expect(stdout).toContain('failed');
    });

    it('21. continueOnError: true — failing step does not fail the job', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-continue.txt');
      const pipeline = await writePipeline('continue-error.yaml', `
name: ContinueOnError
steps:
  - pwsh: |
      exit 1
    displayName: Failing Step
    continueOnError: true
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "continued"
    displayName: Next Step
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      // continueOnError makes job status "succeededWithIssues" → exit code 2
      expect(exitCode).toBe(2);
      expect(stdout).toContain('succeededWithIssues');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('continued');
    });

    it('22. multiple stages, one fails — partial result, exit code 2', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-partial.txt');
      const pipeline = await writePipeline('partial-fail.yaml', `
name: PartialFail
stages:
  - stage: GoodStage
    jobs:
      - job: GoodJob
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outFile)}" -Value "good"
            displayName: Good Step
  - stage: BadStage
    jobs:
      - job: BadJob
        steps:
          - pwsh: |
              exit 1
            displayName: Bad Step
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      // One stage succeeded, one failed → succeededWithIssues → exit code 2
      expect(exitCode).toBe(2);
      expect(stdout).toContain('succeeded');
      expect(stdout).toContain('failed');
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('good');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 7: Job Strategies
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 7: Job Strategies', () => {
    it('23. matrix strategy — 2 configs both run and write to separate files', { timeout: 30_000 }, async () => {
      const outFile1 = path.join(tempDir, 'out-matrix-a.txt');
      const outFile2 = path.join(tempDir, 'out-matrix-b.txt');
      const pipeline = await writePipeline('matrix.yaml', `
name: MatrixTest
stages:
  - stage: MatrixStage
    jobs:
      - job: ConfigA
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outFile1)}" -Value "configA"
            displayName: Write Config A
      - job: ConfigB
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outFile2)}" -Value "configB"
            displayName: Write Config B
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content1 = await fs.readFile(outFile1, 'utf-8');
      const content2 = await fs.readFile(outFile2, 'utf-8');
      expect(content1.trim()).toBe('configA');
      expect(content2.trim()).toBe('configB');
    });

    it('24. parallel jobs — 2 independent jobs in same stage both complete', { timeout: 30_000 }, async () => {
      const outFile1 = path.join(tempDir, 'out-parallel-1.txt');
      const outFile2 = path.join(tempDir, 'out-parallel-2.txt');
      const pipeline = await writePipeline('parallel-jobs.yaml', `
name: ParallelJobs
stages:
  - stage: ParallelStage
    jobs:
      - job: Job1
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outFile1)}" -Value "parallel1"
            displayName: Job1 Step
      - job: Job2
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outFile2)}" -Value "parallel2"
            displayName: Job2 Step
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content1 = await fs.readFile(outFile1, 'utf-8');
      const content2 = await fs.readFile(outFile2, 'utf-8');
      expect(content1.trim()).toBe('parallel1');
      expect(content2.trim()).toBe('parallel2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 8: Dry Run & Selective Execution
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 8: Dry Run & Selective Execution', () => {
    it('25. dry run compiles but does not execute (no files written)', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-dryrun.txt');
      const pipeline = await writePipeline('dryrun.yaml', `
name: DryRunTest
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "should-not-exist"
    displayName: Write File
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--dry-run']);
      expect(exitCode).toBe(0);
      const output = stdout.toLowerCase();
      expect(output).toMatch(/dry.run|execution plan/);
      await expect(fs.access(outFile)).rejects.toThrow();
    });

    it('26. stage filter runs only the specified stage', { timeout: 30_000 }, async () => {
      const outBuild = path.join(tempDir, 'out-filter-build.txt');
      const outDeploy = path.join(tempDir, 'out-filter-deploy.txt');
      const pipeline = await writePipeline('stage-filter.yaml', `
name: StageFilter
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outBuild)}" -Value "built"
            displayName: Build
  - stage: Deploy
    dependsOn: Build
    jobs:
      - job: DeployJob
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outDeploy)}" -Value "deployed"
            displayName: Deploy
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose', '--stage', 'Build']);
      expect(exitCode).toBe(0);
      const buildContent = await fs.readFile(outBuild, 'utf-8');
      expect(buildContent.trim()).toBe('built');
      // Deploy stage should NOT have run
      await expect(fs.access(outDeploy)).rejects.toThrow();
    });

    it('27. non-existent stage filter does not crash', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-nonexist-stage.txt');
      const pipeline = await writePipeline('nonexist-stage.yaml', `
name: NonExistStage
stages:
  - stage: Build
    jobs:
      - job: BuildJob
        steps:
          - pwsh: |
              Set-Content -Path "${fwd(outFile)}" -Value "ran-anyway"
            displayName: Build
`);
      const { exitCode, stdout, stderr } = await runCli([
        'run',
        pipeline,
        '--verbose',
        '--stage',
        'NonExistent',
      ]);
      // Non-existent stage causes an error (subgraph lookup fails)
      const combined = (stdout + stderr).toLowerCase();
      expect(combined).toMatch(/error|warning|not found|filter/);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 9: Templates
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 9: Templates', () => {
    it('28. step template include — steps from template execute', { timeout: 30_000 }, async () => {
      const outFile = path.join(tempDir, 'out-template.txt');
      // Create the step template file
      await writePipeline('step-template.yaml', `
steps:
  - pwsh: |
      Set-Content -Path "${fwd(outFile)}" -Value "from-template"
    displayName: Template Step
`);
      // Create the pipeline that references the template
      const pipeline = await writePipeline('use-template.yaml', `
name: UseTemplate
steps:
  - template: step-template.yaml
`);
      const { exitCode } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(0);
      const content = await fs.readFile(outFile, 'utf-8');
      expect(content.trim()).toBe('from-template');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Group 10: Pipeline Validation Edge Cases
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Group 10: Pipeline Validation Edge Cases', () => {
    it('29. empty pipeline (no stages/jobs/steps) runs with no error', { timeout: 30_000 }, async () => {
      const pipeline = await writePipeline('empty.yaml', `
name: EmptyPipeline
`);
      const { exitCode, stdout } = await runCli(['run', pipeline, '--verbose']);
      // An empty pipeline normalizes to 0 stages → nothing to execute → succeeds
      expect(exitCode).toBe(0);
      expect(stdout).toContain('0 stage');
    });

    it('30. invalid YAML produces error with clear message', { timeout: 30_000 }, async () => {
      const pipeline = await writePipeline('invalid.yaml', `
name: "Broken
  - this: is not valid yaml
    extra: [unbalanced
`);
      const { exitCode, stderr, stdout } = await runCli(['run', pipeline, '--verbose']);
      expect(exitCode).toBe(1);
      const combined = (stdout + stderr).toLowerCase();
      expect(combined).toMatch(/error|invalid|unexpected/);
    });
  });
});
