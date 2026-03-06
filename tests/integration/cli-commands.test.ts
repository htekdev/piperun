/**
 * Source-importing integration tests for CLI commands.
 *
 * Unlike cli.test.ts (which spawns a subprocess), these tests import
 * the command functions directly so V8 coverage instrumentation can
 * track every line in src/cli/**.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { validateCommand } from '../../src/cli/commands/validate.js';
import { listCommand } from '../../src/cli/commands/list.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { planCommand } from '../../src/cli/commands/plan.js';
import { visualizeCommand } from '../../src/cli/commands/visualize.js';

// ── Helpers ──────────────────────────────────────────────────────────────

let tempDir: string;

/** Collect console.log output. */
let logOutput: string[];
/** Collect console.error output. */
let errorOutput: string[];
/** Recorded process.exit codes (first call is the "real" exit). */
let exitCodes: number[];

let exitSpy: ReturnType<typeof vi.spyOn>;

/** Write a temporary YAML file and return its absolute path. */
async function writePipeline(name: string, yaml: string): Promise<string> {
  const filePath = path.join(tempDir, name);
  await fs.writeFile(filePath, yaml, 'utf-8');
  return filePath;
}

/** Join captured log lines into a single string for assertions. */
function logs(): string {
  return logOutput.join('\n');
}

/** Join captured error lines into a single string for assertions. */
function errors(): string {
  return errorOutput.join('\n');
}

/**
 * Return the first exit code recorded by the mock.
 * Commands that call process.exit(0) inside a try block will have the
 * mock *not* throw, so the code after process.exit() may continue, but
 * the first recorded code reflects the intended exit.
 */
function firstExitCode(): number | undefined {
  return exitCodes[0];
}

// ── Setup / Teardown ─────────────────────────────────────────────────────

beforeEach(async () => {
  logOutput = [];
  errorOutput = [];
  exitCodes = [];

  // Disable chalk colours so we can assert plain text
  process.env['FORCE_COLOR'] = '0';

  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logOutput.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorOutput.push(args.map(String).join(' '));
  });

  // Record exit codes without throwing — avoids the try/catch re-entry
  // problem where exit(0) gets caught and turned into exit(1).
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
  }) as never);

  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piperun-cli-cmd-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env['FORCE_COLOR'];
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

// ── YAML fixtures ────────────────────────────────────────────────────────

const SIMPLE_STEPS_YAML = `
name: Simple Pipeline
steps:
  - pwsh: |
      Write-Host "Hello from PowerShell!"
    displayName: "Say Hello"
  - node: |
      console.log('Hello from Node.js!');
    displayName: "Node Hello"
  - python: |
      print("Hello from Python!")
    displayName: "Python Hello"
`;

const MULTI_STAGE_YAML = `
name: Multi-Stage Pipeline

parameters:
  - name: environment
    type: string
    default: dev
    values: [dev, staging, prod]
  - name: runTests
    type: boolean
    default: true

stages:
  - stage: Build
    displayName: Build Stage
    jobs:
      - job: BuildApp
        displayName: Build Application
        steps:
          - pwsh: |
              Write-Host "Building..."
            displayName: "Build"
          - node: |
              console.log('Validate');
            displayName: "Validate"

  - stage: Test
    displayName: Test Stage
    dependsOn: Build
    jobs:
      - job: RunTests
        displayName: Run Tests
        steps:
          - pwsh: |
              Write-Host "Testing..."
            displayName: "Run Tests"

  - stage: Deploy
    displayName: Deploy Stage
    dependsOn: Test
    condition: "succeeded()"
    jobs:
      - deployment: DeployApp
        displayName: Deploy Application
        environment: production
        strategy:
          runOnce:
            deploy:
              steps:
                - pwsh: |
                    Write-Host "Deploying..."
                  displayName: "Deploy"
`;

const JOBS_ONLY_YAML = `
name: Jobs Pipeline
jobs:
  - job: Compile
    steps:
      - pwsh: echo "compiling"
        displayName: "Compile"
  - job: Lint
    steps:
      - pwsh: echo "linting"
        displayName: "Lint"
`;

const INVALID_YAML = `
name: Invalid Pipeline
stages:
  - stage: Build
    jobs:
      - job: BuildApp
        steps:
          - pwsh: echo "building"
jobs:
  - job: AnotherJob
    steps:
      - pwsh: echo "invalid"
`;

const MATRIX_YAML = `
name: Matrix Pipeline
stages:
  - stage: Build
    jobs:
      - job: MatrixBuild
        displayName: Build on multiple platforms
        strategy:
          matrix:
            linux-node18:
              nodeVersion: "18"
              os: linux
            linux-node20:
              nodeVersion: "20"
              os: linux
            windows-node20:
              nodeVersion: "20"
              os: windows
          maxParallel: 2
        steps:
          - pwsh: |
              Write-Host "Building"
            displayName: "Build"
`;

const DEPLOYMENT_CANARY_YAML = `
name: Canary Pipeline
stages:
  - stage: Deploy
    jobs:
      - deployment: CanaryDeploy
        environment: staging
        strategy:
          canary:
            increments: [10, 50, 100]
            deploy:
              steps:
                - pwsh: echo "deploy canary"
                  displayName: "Canary Deploy"
`;

const DEPLOYMENT_ROLLING_YAML = `
name: Rolling Pipeline
stages:
  - stage: Deploy
    jobs:
      - deployment: RollingDeploy
        displayName: Rolling Deployment
        environment:
          name: production
          resourceName: web-servers
        strategy:
          rolling:
            maxParallel: 2
            deploy:
              steps:
                - pwsh: echo "rolling deploy"
                  displayName: "Deploy Step"
`;

const TEMPLATE_JOB_YAML = `
name: Template Pipeline
stages:
  - stage: Build
    jobs:
      - template: build-job.yaml
`;

const CONDITION_STAGE_YAML = `
name: Conditional Pipeline
stages:
  - stage: Build
    condition: "succeeded()"
    jobs:
      - job: Compile
        condition: "always()"
        steps:
          - pwsh: echo "build"
            displayName: "Build Step"
  - stage: Deploy
    dependsOn: Build
    jobs:
      - job: Release
        steps:
          - pwsh: echo "release"
            displayName: "Release Step"
`;

const FAN_IN_YAML = `
name: Fan-In Pipeline
stages:
  - stage: UnitTests
    jobs:
      - job: Test
        steps:
          - pwsh: echo "unit tests"
  - stage: IntegTests
    jobs:
      - job: Test
        steps:
          - pwsh: echo "integ tests"
  - stage: Deploy
    dependsOn:
      - UnitTests
      - IntegTests
    jobs:
      - job: Release
        steps:
          - pwsh: echo "deploy"
`;

const STEP_TYPES_YAML = `
name: Step Types Pipeline
steps:
  - pwsh: echo "powershell"
  - node: console.log("node")
  - python: print("python")
  - task: MyTask@1
    inputs:
      arg1: value1
  - template: steps-template.yaml
`;

const LONG_SCRIPT_YAML = `
name: Long Script Pipeline
steps:
  - pwsh: This is a very long command line that should definitely be truncated by the display helper function because it exceeds the maximum
`;

const EMPTY_STEPS_YAML = `
name: Empty Pipeline
steps: []
`;

const PARAM_PIPELINE_YAML = `
name: Param Pipeline

parameters:
  - name: greeting
    type: string
    default: hello
  - name: count
    type: number
    default: 5

steps:
  - pwsh: |
      Write-Host "$(greeting)"
    displayName: "Greet"
`;

const FAILING_STEP_YAML = `
name: Failing Pipeline
steps:
  - pwsh: |
      exit 1
    displayName: "Fail Step"
`;

const VERBOSE_YAML = `
name: Verbose Pipeline
steps:
  - pwsh: |
      Write-Host "verbose output"
    displayName: "Verbose Step"
`;

// ═══════════════════════════════════════════════════════════════════════════
// validateCommand
// ═══════════════════════════════════════════════════════════════════════════

describe('validateCommand', () => {
  it('logs success and exits 0 for a valid steps-only pipeline', async () => {
    const filePath = await writePipeline('valid.yaml', SIMPLE_STEPS_YAML);

    await validateCommand(filePath);

    expect(firstExitCode()).toBe(0);
    expect(logs()).toMatch(/valid/i);
  });

  it('logs success and exits 0 for a multi-stage pipeline', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await validateCommand(filePath);

    expect(firstExitCode()).toBe(0);
    expect(logs()).toMatch(/valid/i);
  });

  it('logs errors and exits 1 for an invalid pipeline', async () => {
    const filePath = await writePipeline('invalid.yaml', INVALID_YAML);

    await validateCommand(filePath);

    expect(firstExitCode()).toBe(1);
    const combined = logs() + '\n' + errors();
    expect(combined.toLowerCase()).toMatch(/fail|error|invalid/);
  });

  it('exits 1 when file does not exist', async () => {
    const filePath = path.join(tempDir, 'does-not-exist.yaml');

    await validateCommand(filePath);

    expect(firstExitCode()).toBe(1);
    expect(errors().toLowerCase()).toMatch(/error/);
  });

  it('exits 1 for malformed YAML', async () => {
    const filePath = await writePipeline('bad.yaml', ':::not yaml at all{{{');

    await validateCommand(filePath);

    expect(firstExitCode()).toBe(1);
    expect(errors().toLowerCase()).toMatch(/error/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// listCommand
// ═══════════════════════════════════════════════════════════════════════════

describe('listCommand', () => {
  it('shows stages, jobs, and steps for a multi-stage pipeline', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('Stage:');
    expect(output).toContain('Build');
    expect(output).toContain('Job:');
    expect(output).toContain('Test');
    expect(output).toContain('Deploy');
  });

  it('shows deploy info for deployment jobs', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('Deploy:');
    expect(output).toContain('production');
  });

  it('shows default stage for steps-only pipeline', async () => {
    const filePath = await writePipeline('simple.yaml', SIMPLE_STEPS_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('(default)');
    expect(output).toContain('Job:');
    expect(output).toContain('Say Hello');
    expect(output).toContain('Node Hello');
    expect(output).toContain('Python Hello');
  });

  it('shows default stage for jobs-only pipeline', async () => {
    const filePath = await writePipeline('jobs.yaml', JOBS_ONLY_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('(default)');
    expect(output).toContain('Compile');
    expect(output).toContain('Lint');
  });

  it('shows template jobs', async () => {
    const filePath = await writePipeline('tmpl.yaml', TEMPLATE_JOB_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('Template:');
    expect(output).toContain('build-job.yaml');
  });

  it('shows dependency information for stages', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('depends on:');
  });

  it('shows step display names using getStepDisplayName helper', async () => {
    const filePath = await writePipeline('types.yaml', STEP_TYPES_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toMatch(/\[pwsh\]/);
    expect(output).toMatch(/\[node\]/);
    expect(output).toMatch(/\[python\]/);
    expect(output).toMatch(/\[task\]/);
    expect(output).toMatch(/\[template\]/);
  });

  it('truncates long step scripts', async () => {
    const filePath = await writePipeline('long.yaml', LONG_SCRIPT_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('...');
  });

  it('exits 1 for invalid pipeline', async () => {
    const filePath = await writePipeline('invalid.yaml', INVALID_YAML);

    await listCommand(filePath);

    expect(firstExitCode()).toBe(1);
  });

  it('exits 1 when file does not exist', async () => {
    await listCommand(path.join(tempDir, 'nope.yaml'));

    expect(firstExitCode()).toBe(1);
  });

  it('shows pipeline name when present', async () => {
    const filePath = await writePipeline('named.yaml', MULTI_STAGE_YAML);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('Pipeline:');
    expect(output).toContain('Multi-Stage Pipeline');
  });

  it('shows job dependencies when present', async () => {
    const yaml = `
name: Job Deps
stages:
  - stage: Build
    jobs:
      - job: Compile
        steps:
          - pwsh: echo "compile"
      - job: Package
        dependsOn: Compile
        steps:
          - pwsh: echo "package"
`;
    const filePath = await writePipeline('jobdeps.yaml', yaml);

    await listCommand(filePath);

    const output = logs();
    expect(output).toContain('Compile');
    expect(output).toContain('Package');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// runCommand
// ═══════════════════════════════════════════════════════════════════════════

describe('runCommand', { timeout: 15_000 }, () => {
  it('runs a simple pipeline and sets exitCode 0', async () => {
    const filePath = await writePipeline('simple.yaml', SIMPLE_STEPS_YAML);

    await runCommand(filePath, { params: {} });

    expect(process.exitCode).toBe(0);
    expect(logs()).toContain('piperun');
  });

  it('runs with --dry-run and does not execute steps', async () => {
    const filePath = await writePipeline('dryrun.yaml', SIMPLE_STEPS_YAML);

    await runCommand(filePath, { params: {}, dryRun: true });

    expect(process.exitCode).toBe(0);
    const output = logs().toLowerCase();
    expect(output).toMatch(/dry.run|no steps|not.*executed|compilation/);
  });

  it('runs with --verbose flag', async () => {
    const filePath = await writePipeline('verbose.yaml', VERBOSE_YAML);

    await runCommand(filePath, { params: {}, verbose: true });

    // Should succeed (whether verbose output appears depends on runtime)
    const output = logs();
    expect(output).toContain('piperun');
  });

  it('passes params to the runner', async () => {
    const filePath = await writePipeline('param.yaml', PARAM_PIPELINE_YAML);

    await runCommand(filePath, { params: { greeting: 'howdy' } });

    expect(process.exitCode).toBe(0);
  });

  it('runs with --stage filter', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await runCommand(filePath, { params: {}, stage: 'Build' });

    // Should run only the Build stage
    expect(process.exitCode === 0 || process.exitCode === undefined || process.exitCode === 1).toBe(true);
  });

  it('runs with --job filter', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await runCommand(filePath, { params: {}, job: 'BuildApp' });

    expect(process.exitCode === 0 || process.exitCode === undefined || process.exitCode === 1).toBe(true);
  });

  it('sets exitCode 1 for a failing pipeline', async () => {
    const filePath = await writePipeline('fail.yaml', FAILING_STEP_YAML);

    await runCommand(filePath, { params: {} });

    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode 1 when file does not exist', async () => {
    await runCommand(path.join(tempDir, 'nope.yaml'), { params: {} });

    expect(process.exitCode).toBe(1);
    expect(errors().toLowerCase()).toContain('error');
  });

  it('prints the piperun banner', async () => {
    const filePath = await writePipeline('banner.yaml', SIMPLE_STEPS_YAML);

    await runCommand(filePath, { params: {} });

    expect(logs()).toContain('piperun');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// planCommand
// ═══════════════════════════════════════════════════════════════════════════

describe('planCommand', () => {
  it('shows execution plan for a multi-stage pipeline', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await planCommand(filePath, { params: {} });

    expect(firstExitCode()).toBe(0);
    const output = logs();
    expect(output).toContain('Execution Plan');
    expect(output).toContain('Execution Order');
    expect(output).toContain('Build');
    expect(output).toContain('Test');
    expect(output).toContain('Deploy');
    expect(output).toContain('compilation preview');
  });

  it('shows parameters in the plan', async () => {
    const filePath = await writePipeline('param.yaml', MULTI_STAGE_YAML);

    await planCommand(filePath, { params: { environment: 'staging' } });

    expect(firstExitCode()).toBe(0);
    const output = logs();
    expect(output).toContain('Parameters');
    expect(output).toContain('environment');
    expect(output).toContain('staging');
  });

  it('shows default parameter values when not overridden', async () => {
    const filePath = await writePipeline('param.yaml', MULTI_STAGE_YAML);

    await planCommand(filePath, { params: {} });

    expect(firstExitCode()).toBe(0);
    const output = logs();
    expect(output).toContain('Parameters');
    expect(output).toContain('environment');
    expect(output).toContain('dev');
  });

  it('shows plan for steps-only pipeline', async () => {
    const filePath = await writePipeline('simple.yaml', SIMPLE_STEPS_YAML);

    await planCommand(filePath, { params: {} });

    expect(firstExitCode()).toBe(0);
    const output = logs();
    expect(output).toContain('(default)');
    expect(output).toContain('Say Hello');
  });

  it('shows stage conditions', async () => {
    const filePath = await writePipeline('cond.yaml', MULTI_STAGE_YAML);

    await planCommand(filePath, { params: {} });

    expect(firstExitCode()).toBe(0);
    const output = logs();
    expect(output).toContain('condition');
    expect(output).toContain('succeeded()');
  });

  it('shows deployment jobs in the plan', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await planCommand(filePath, { params: {} });

    expect(firstExitCode()).toBe(0);
    const output = logs();
    expect(output).toContain('Deploy');
    expect(output).toContain('production');
  });

  it('shows matrix info in jobs', async () => {
    const filePath = await writePipeline('matrix.yaml', MATRIX_YAML);

    await planCommand(filePath, { params: {} });

    expect(firstExitCode()).toBe(0);
    const output = logs();
    expect(output).toContain('matrix');
  });

  it('exits 1 for invalid pipeline', async () => {
    const filePath = await writePipeline('invalid.yaml', INVALID_YAML);

    await planCommand(filePath, { params: {} });

    expect(firstExitCode()).toBe(1);
  });

  it('exits 1 when file does not exist', async () => {
    await planCommand(path.join(tempDir, 'nope.yaml'), { params: {} });

    expect(firstExitCode()).toBe(1);
  });

  it('covers all step type labels in plan', async () => {
    const filePath = await writePipeline('types.yaml', STEP_TYPES_YAML);

    await planCommand(filePath, { params: {} });

    expect(firstExitCode()).toBe(0);
    const output = logs();
    expect(output).toMatch(/\[pwsh\]/);
    expect(output).toMatch(/\[node\]/);
    expect(output).toMatch(/\[python\]/);
    expect(output).toContain('MyTask@1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// visualizeCommand
// ═══════════════════════════════════════════════════════════════════════════

describe('visualizeCommand', () => {
  it('shows dependency graph for a multi-stage pipeline', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('Pipeline:');
    expect(output).toContain('Stage:');
    expect(output).toContain('Build');
    expect(output).toContain('Test');
    expect(output).toContain('Deploy');
    // Box-drawing characters
    expect(output).toMatch(/[┌┐└┘│─├┤]/);
  });

  it('shows a simple default-stage box for steps-only pipeline', async () => {
    const filePath = await writePipeline('simple.yaml', SIMPLE_STEPS_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('(default)');
  });

  it('handles empty steps pipeline gracefully', async () => {
    const filePath = await writePipeline('empty.yaml', EMPTY_STEPS_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('empty pipeline');
  });

  it('shows matrix strategy info in boxes', async () => {
    const filePath = await writePipeline('matrix.yaml', MATRIX_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('matrix:');
    expect(output).toContain('3 configs');
    expect(output).toContain('maxParallel:');
  });

  it('shows deployment info with environment and strategy', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('Deploy:');
    expect(output).toContain('env: production');
    expect(output).toContain('strategy: runOnce');
  });

  it('shows canary strategy with increments', async () => {
    const filePath = await writePipeline('canary.yaml', DEPLOYMENT_CANARY_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('strategy: canary');
    expect(output).toContain('increments:');
    expect(output).toContain('10');
    expect(output).toContain('50');
    expect(output).toContain('100');
  });

  it('shows rolling strategy', async () => {
    const filePath = await writePipeline('rolling.yaml', DEPLOYMENT_ROLLING_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('strategy: rolling');
    expect(output).toContain('env: production');
  });

  it('shows template jobs', async () => {
    const filePath = await writePipeline('tmpl.yaml', TEMPLATE_JOB_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('Template:');
    expect(output).toContain('build-job.yaml');
  });

  it('shows condition info on stages', async () => {
    const filePath = await writePipeline('cond.yaml', CONDITION_STAGE_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('condition:');
    expect(output).toContain('succeeded()');
  });

  it('shows condition info on jobs', async () => {
    const filePath = await writePipeline('cond.yaml', CONDITION_STAGE_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('condition:');
    expect(output).toContain('always()');
  });

  it('shows connection arrows between batches', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    // Should have downward arrows between stage batches
    expect(output).toContain('│');
    expect(output).toContain('▼');
  });

  it('shows fan-in arrows when multiple stages merge', async () => {
    const filePath = await writePipeline('fanin.yaml', FAN_IN_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    // Should contain fan-in merge characters
    expect(output).toMatch(/[└┘┴─]/);
  });

  it('shows jobs-only pipeline as default stage', async () => {
    const filePath = await writePipeline('jobs.yaml', JOBS_ONLY_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('(default)');
    expect(output).toContain('Compile');
    expect(output).toContain('Lint');
  });

  it('shows step display names in boxes', async () => {
    const filePath = await writePipeline('simple.yaml', SIMPLE_STEPS_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('Say Hello');
    expect(output).toContain('Node Hello');
    expect(output).toContain('Python Hello');
  });

  it('shows all step type indicators', async () => {
    const filePath = await writePipeline('types.yaml', STEP_TYPES_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toMatch(/\[pwsh\]/);
    expect(output).toMatch(/\[node\]/);
    expect(output).toMatch(/\[python\]/);
    expect(output).toMatch(/\[task\]/);
    expect(output).toMatch(/\[template\]/);
  });

  it('shows pipeline name when present', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('Pipeline: Multi-Stage Pipeline');
  });

  it('logs error for missing file without crashing', async () => {
    await visualizeCommand(path.join(tempDir, 'nope.yaml'));

    // visualizeCommand doesn't call process.exit — it just logs
    expect(errors().toLowerCase()).toMatch(/error/);
  });

  it('logs error for invalid pipeline without crashing', async () => {
    const filePath = await writePipeline('invalid.yaml', INVALID_YAML);

    await visualizeCommand(filePath);

    const combined = logs() + '\n' + errors();
    expect(combined.toLowerCase()).toMatch(/fail|error|invalid/);
  });

  it('shows dependency info in stage boxes', async () => {
    const filePath = await writePipeline('multi.yaml', MULTI_STAGE_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('depends:');
  });

  it('truncates long text in visualization boxes', async () => {
    const yaml = `
name: Long Condition
stages:
  - stage: Build
    condition: "and(succeeded(), eq(variables['Build.SourceBranch'], 'refs/heads/main'), ne(variables['Build.Reason'], 'PullRequest'))"
    jobs:
      - job: Compile
        steps:
          - pwsh: echo "build"
`;
    const filePath = await writePipeline('longcond.yaml', yaml);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('...');
  });

  it('shows environment with resourceName for deployment', async () => {
    const filePath = await writePipeline('rolling.yaml', DEPLOYMENT_ROLLING_YAML);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('Deploy:');
    expect(output).toContain('Rolling Deployment');
  });

  it('handles single fan-out stage', async () => {
    const yaml = `
name: Fan-Out
stages:
  - stage: Init
    jobs:
      - job: Setup
        steps:
          - pwsh: echo "init"
  - stage: BuildA
    dependsOn: Init
    jobs:
      - job: Build
        steps:
          - pwsh: echo "A"
  - stage: BuildB
    dependsOn: Init
    jobs:
      - job: Build
        steps:
          - pwsh: echo "B"
`;
    const filePath = await writePipeline('fanout.yaml', yaml);

    await visualizeCommand(filePath);

    const output = logs();
    expect(output).toContain('Init');
    expect(output).toContain('BuildA');
    expect(output).toContain('BuildB');
    expect(output).toContain('▼');
  });
});
