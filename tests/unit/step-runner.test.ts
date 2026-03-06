import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { StepRunner, type StepRunnerOptions, type StepResult } from '../../src/runtime/step-runner.js';
import { SecretMasker } from '../../src/variables/secret-masker.js';
import type { PwshStep, NodeStep, PythonStep, TaskStep, StepDefinition } from '../../src/types/pipeline.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function hasBinary(name: string): boolean {
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasPwsh = hasBinary('pwsh');
const hasNode = true; // We're running in Node — it's always available
const hasPython = platform() === 'win32' ? hasBinary('python') : hasBinary('python3');

function createRunner(
  overrides?: Partial<StepRunnerOptions>,
): { runner: StepRunner; masker: SecretMasker } {
  const masker = new SecretMasker();
  const opts: StepRunnerOptions = {
    workingDirectory: process.cwd(),
    environment: {},
    secretMasker: masker,
    ...overrides,
  };
  return { runner: new StepRunner(opts), masker };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('StepRunner', () => {
  describe('pwsh step execution', () => {
    it.skipIf(!hasPwsh)('executes a pwsh step and captures stdout', async () => {
      const { runner } = createRunner();
      const step: PwshStep = { pwsh: 'Write-Output "hello from pwsh"' };

      const result = await runner.executeStep(step, 'test-pwsh');

      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello from pwsh');
    }, 10_000);

    it.skipIf(!hasPwsh)('captures pwsh non-zero exit code as failed', async () => {
      const { runner } = createRunner();
      const step: PwshStep = { pwsh: 'exit 42' };

      const result = await runner.executeStep(step, 'test-pwsh-fail');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(42);
    }, 10_000);
  });

  describe('node step execution', () => {
    it.skipIf(!hasNode)('executes a node step and captures stdout', async () => {
      const { runner } = createRunner();
      const step: NodeStep = { node: 'console.log("hello from node");' };

      const result = await runner.executeStep(step, 'test-node');

      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello from node');
    }, 10_000);

    it.skipIf(!hasNode)('captures node non-zero exit code as failed', async () => {
      const { runner } = createRunner();
      const step: NodeStep = { node: 'process.exit(1);' };

      const result = await runner.executeStep(step, 'test-node-fail');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    }, 10_000);
  });

  describe('python step execution', () => {
    it.skipIf(!hasPython)('executes a python step and captures stdout', async () => {
      const { runner } = createRunner();
      const step: PythonStep = { python: 'print("hello from python")' };

      const result = await runner.executeStep(step, 'test-python');

      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello from python');
    }, 10_000);

    it.skipIf(!hasPython)('captures python non-zero exit code as failed', async () => {
      const { runner } = createRunner();
      const step: PythonStep = { python: 'import sys; sys.exit(2)' };

      const result = await runner.executeStep(step, 'test-python-fail');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(2);
    }, 10_000);
  });

  describe('task step', () => {
    it('returns a proper error for task steps (not yet implemented)', async () => {
      const { runner } = createRunner();
      const step: TaskStep = { task: 'SomeTask@1', inputs: { arg: 'value' } };

      const result = await runner.executeStep(step, 'test-task');

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not yet implemented');
      expect(result.stderr).toContain('SomeTask@1');
    });
  });

  describe('step with enabled: false', () => {
    it('skips a step when enabled is false', async () => {
      const { runner } = createRunner();
      const step: NodeStep = { node: 'console.log("should not run")', enabled: false };

      const result = await runner.executeStep(step, 'test-disabled');

      expect(result.status).toBe('skipped');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.duration).toBe(0);
    });
  });

  describe('continueOnError', () => {
    it.skipIf(!hasNode)('marks failed step as succeededWithIssues when continueOnError is true', async () => {
      const { runner } = createRunner();
      const step: NodeStep = {
        node: 'process.exit(1);',
        continueOnError: true,
      };

      const result = await runner.executeStep(step, 'test-continue');

      expect(result.status).toBe('succeededWithIssues');
      expect(result.exitCode).toBe(1);
    }, 10_000);

    it.skipIf(!hasNode)('does not change status when step succeeds and continueOnError is true', async () => {
      const { runner } = createRunner();
      const step: NodeStep = {
        node: 'console.log("ok");',
        continueOnError: true,
      };

      const result = await runner.executeStep(step, 'test-continue-ok');

      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
    }, 10_000);
  });

  describe('environment variables', () => {
    it.skipIf(!hasNode)('passes environment variables to the child process', async () => {
      const { runner } = createRunner({
        environment: { PIPERUN_TEST_VAR: 'base_value' },
      });
      const step: NodeStep = {
        node: 'console.log(process.env.PIPERUN_TEST_VAR);',
      };

      const result = await runner.executeStep(step, 'test-env');

      expect(result.status).toBe('succeeded');
      expect(result.stdout).toContain('base_value');
    }, 10_000);

    it.skipIf(!hasNode)('merges step env over base environment', async () => {
      const { runner } = createRunner({
        environment: { PIPERUN_TEST_VAR: 'base_value' },
      });
      const step: NodeStep = {
        node: 'console.log(process.env.PIPERUN_TEST_VAR);',
        env: { PIPERUN_TEST_VAR: 'step_value' },
      };

      const result = await runner.executeStep(step, 'test-env-merge');

      expect(result.status).toBe('succeeded');
      expect(result.stdout).toContain('step_value');
    }, 10_000);
  });

  describe('timeout', () => {
    it.skipIf(!hasNode)('kills process when timeout is exceeded', async () => {
      const { runner } = createRunner({ timeoutMs: 500 });
      const step: NodeStep = {
        node: 'setTimeout(() => {}, 30000);', // sleep for 30s
      };

      const result = await runner.executeStep(step, 'test-timeout');

      expect(result.status).toBe('failed');
      expect(result.stderr).toContain('timed out');
    }, 10_000);

    it.skipIf(!hasNode)('uses step timeoutInMinutes over global timeout', async () => {
      const { runner } = createRunner({ timeoutMs: 60_000 });
      // Step timeout of 0.01 minutes = 600ms
      const step: NodeStep = {
        node: 'setTimeout(() => {}, 30000);',
        timeoutInMinutes: 0.01,
      };

      const result = await runner.executeStep(step, 'test-step-timeout');

      expect(result.status).toBe('failed');
      expect(result.stderr).toContain('timed out');
    }, 10_000);
  });

  describe('retry on failure', () => {
    it.skipIf(!hasNode)('retries a failing step up to retryCountOnTaskFailure times', async () => {
      const outputLines: string[] = [];
      const { runner } = createRunner({
        onOutput: (line) => outputLines.push(line),
      });
      const step: NodeStep = {
        node: 'console.log("attempt"); process.exit(1);',
        retryCountOnTaskFailure: 2,
      };

      const result = await runner.executeStep(step, 'test-retry');

      expect(result.status).toBe('failed');
      expect(result.retryCount).toBe(2);
      // Should have run 3 times total (initial + 2 retries)
      const attemptCount = outputLines.filter((l) => l.includes('attempt')).length;
      expect(attemptCount).toBe(3);
    }, 15_000);

    it.skipIf(!hasNode)('does not retry when step succeeds', async () => {
      const outputLines: string[] = [];
      const { runner } = createRunner({
        onOutput: (line) => outputLines.push(line),
      });
      const step: NodeStep = {
        node: 'console.log("attempt"); process.exit(0);',
        retryCountOnTaskFailure: 2,
      };

      const result = await runner.executeStep(step, 'test-retry-ok');

      expect(result.status).toBe('succeeded');
      expect(result.retryCount).toBe(0);
      const attemptCount = outputLines.filter((l) => l.includes('attempt')).length;
      expect(attemptCount).toBe(1);
    }, 10_000);
  });

  describe('secret masking', () => {
    it.skipIf(!hasNode)('masks secret values in stdout', async () => {
      const masker = new SecretMasker();
      masker.addSecret('super-secret-value');
      const { runner } = createRunner({ secretMasker: masker });
      const step: NodeStep = {
        node: 'console.log("the secret is super-secret-value");',
      };

      const result = await runner.executeStep(step, 'test-secret');

      expect(result.status).toBe('succeeded');
      expect(result.stdout).not.toContain('super-secret-value');
      expect(result.stdout).toContain('***');
    }, 10_000);
  });

  describe('logging command parsing', () => {
    it.skipIf(!hasNode)('parses ##pipeline[setvariable] from stdout', async () => {
      const loggingCommands: Array<{
        command: string;
        properties: Record<string, string>;
        value: string;
      }> = [];
      const { runner } = createRunner({
        onLoggingCommand: (command, properties, value) => {
          loggingCommands.push({ command, properties, value });
        },
      });
      const step: NodeStep = {
        node: 'console.log("##pipeline[setvariable variable=myVar;isOutput=true]myValue");',
      };

      const result = await runner.executeStep(step, 'test-logging');

      expect(result.status).toBe('succeeded');
      expect(result.outputs).toHaveProperty('myVar', 'myValue');
      expect(loggingCommands).toHaveLength(1);
      expect(loggingCommands[0].command).toBe('setvariable');
      expect(loggingCommands[0].properties).toEqual({
        variable: 'myVar',
        isOutput: 'true',
      });
      expect(loggingCommands[0].value).toBe('myValue');
    }, 10_000);

    it.skipIf(!hasNode)('captures multiple output variables', async () => {
      const { runner } = createRunner();
      const step: NodeStep = {
        node: [
          'console.log("##pipeline[setvariable variable=var1]value1");',
          'console.log("##pipeline[setvariable variable=var2;isSecret=true]value2");',
          'console.log("regular output");',
        ].join('\n'),
      };

      const result = await runner.executeStep(step, 'test-multi-logging');

      expect(result.status).toBe('succeeded');
      expect(result.outputs).toEqual({ var1: 'value1', var2: 'value2' });
      expect(result.stdout).toContain('regular output');
    }, 10_000);
  });

  describe('output streaming callback', () => {
    it.skipIf(!hasNode)('calls onOutput for each line of stdout and stderr', async () => {
      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const { runner } = createRunner({
        onOutput: (line, stream) => {
          if (stream === 'stdout') stdoutLines.push(line);
          else stderrLines.push(line);
        },
      });
      const step: NodeStep = {
        node: 'console.log("out1"); console.log("out2"); console.error("err1");',
      };

      const result = await runner.executeStep(step, 'test-streaming');

      expect(result.status).toBe('succeeded');
      expect(stdoutLines).toContain('out1');
      expect(stdoutLines).toContain('out2');
      expect(stderrLines).toContain('err1');
    }, 10_000);
  });

  describe('duration tracking', () => {
    it.skipIf(!hasNode)('records execution duration in milliseconds', async () => {
      const { runner } = createRunner();
      const step: NodeStep = {
        node: 'console.log("fast");',
      };

      const result = await runner.executeStep(step, 'test-duration');

      expect(result.status).toBe('succeeded');
      expect(result.duration).toBeGreaterThanOrEqual(0);
      expect(typeof result.duration).toBe('number');
    }, 10_000);
  });
});
