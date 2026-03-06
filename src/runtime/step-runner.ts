// Step runner — executes pwsh/node/python/task steps as child processes.

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';

import type {
  StepDefinition,
  PipelineStatus,
  PwshStep,
  NodeStep,
  PythonStep,
  TaskStep,
} from '../types/pipeline.js';
import type { SecretMasker } from '../variables/secret-masker.js';

// ─── Public types ───────────────────────────────────────────────────────────

export interface StepResult {
  status: PipelineStatus;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number; // milliseconds
  outputs: Record<string, string>; // variables set via ##pipeline[setvariable]
  retryCount: number;
}

export interface StepRunnerOptions {
  workingDirectory: string;
  environment: Record<string, string>;
  timeoutMs?: number;
  secretMasker: SecretMasker;
  onOutput?: (line: string, stream: 'stdout' | 'stderr') => void;
  onLoggingCommand?: (
    command: string,
    properties: Record<string, string>,
    value: string,
  ) => void;
}

// ─── Type guards ────────────────────────────────────────────────────────────

function isPwshStep(step: StepDefinition): step is PwshStep {
  return 'pwsh' in step;
}

function isNodeStep(step: StepDefinition): step is NodeStep {
  return 'node' in step;
}

function isPythonStep(step: StepDefinition): step is PythonStep {
  return 'python' in step;
}

function isTaskStep(step: StepDefinition): step is TaskStep {
  return 'task' in step;
}

// ─── Logging command parser ─────────────────────────────────────────────────

const LOGGING_COMMAND_PATTERN = /^##pipeline\[(\w+)\s*(.*?)\](.*)?$/;

interface ParsedLoggingCommand {
  command: string;
  properties: Record<string, string>;
  value: string;
}

function parseLoggingCommand(line: string): ParsedLoggingCommand | null {
  const match = LOGGING_COMMAND_PATTERN.exec(line);
  if (!match) return null;

  const command = match[1];
  const propsStr = match[2] ?? '';
  const value = match[3] ?? '';

  const properties: Record<string, string> = {};
  if (propsStr.trim().length > 0) {
    const pairs = propsStr.split(';');
    for (const pair of pairs) {
      const eqIndex = pair.indexOf('=');
      if (eqIndex > 0) {
        const key = pair.substring(0, eqIndex).trim();
        const val = pair.substring(eqIndex + 1).trim();
        properties[key] = val;
      }
    }
  }

  return { command, properties, value };
}

// ─── Internal spawn options ─────────────────────────────────────────────────

interface InternalSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

// ─── StepRunner class ───────────────────────────────────────────────────────

export class StepRunner {
  constructor(private readonly options: StepRunnerOptions) {}

  async executeStep(step: StepDefinition, stepName: string): Promise<StepResult> {
    // 1. Check if step is enabled
    if ('enabled' in step && step.enabled === false) {
      return {
        status: 'skipped',
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 0,
        outputs: {},
        retryCount: 0,
      };
    }

    // Build environment: merge base env + step-specific env
    const env: Record<string, string> = {
      ...this.options.environment,
    };
    if ('env' in step && step.env) {
      Object.assign(env, step.env);
    }

    // Determine timeout
    const timeoutMs =
      'timeoutInMinutes' in step && step.timeoutInMinutes
        ? step.timeoutInMinutes * 60_000
        : this.options.timeoutMs;

    const retryCount =
      'retryCountOnTaskFailure' in step && step.retryCountOnTaskFailure
        ? step.retryCountOnTaskFailure
        : 0;
    const continueOnError =
      'continueOnError' in step ? step.continueOnError === true : false;

    // Dispatch by step type
    let result: StepResult;
    let attempt = 0;

    while (true) {
      if (isPwshStep(step)) {
        result = await this.executePwsh(step.pwsh, env, timeoutMs);
      } else if (isNodeStep(step)) {
        result = await this.executeNode(step.node, env, timeoutMs);
      } else if (isPythonStep(step)) {
        result = await this.executePython(step.python, env, timeoutMs);
      } else if (isTaskStep(step)) {
        result = await this.executeTask(step.task, step.inputs ?? {}, env);
      } else {
        // Template references are resolved before reaching the runner
        result = {
          status: 'failed',
          exitCode: 1,
          stdout: '',
          stderr: `Unsupported step type for step "${stepName}"`,
          duration: 0,
          outputs: {},
          retryCount: attempt,
        };
        break;
      }

      result.retryCount = attempt;

      // If succeeded or we've exhausted retries, stop
      if (result.status === 'succeeded' || attempt >= retryCount) {
        break;
      }

      attempt++;
    }

    // Handle continueOnError
    if (result.status === 'failed' && continueOnError) {
      result.status = 'succeededWithIssues';
    }

    return result;
  }

  private async executePwsh(
    code: string,
    env: Record<string, string>,
    timeoutMs?: number,
  ): Promise<StepResult> {
    const tempFile = await this.writeTempFile(code, '.ps1');
    try {
      return await this.spawnProcess({
        command: 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-File', tempFile],
        cwd: this.options.workingDirectory,
        env,
        timeoutMs,
      });
    } finally {
      await this.cleanupTempFile(tempFile);
    }
  }

  private async executeNode(
    code: string,
    env: Record<string, string>,
    timeoutMs?: number,
  ): Promise<StepResult> {
    const tempFile = await this.writeTempFile(code, '.mjs');
    try {
      return await this.spawnProcess({
        command: process.execPath,
        args: [tempFile],
        cwd: this.options.workingDirectory,
        env,
        timeoutMs,
      });
    } finally {
      await this.cleanupTempFile(tempFile);
    }
  }

  private async executePython(
    code: string,
    env: Record<string, string>,
    timeoutMs?: number,
  ): Promise<StepResult> {
    const tempFile = await this.writeTempFile(code, '.py');
    try {
      // On Windows, 'python' is more common; on Unix, prefer 'python3'
      const pythonCommand = platform() === 'win32' ? 'python' : 'python3';
      return await this.spawnProcess({
        command: pythonCommand,
        args: [tempFile],
        cwd: this.options.workingDirectory,
        env,
        timeoutMs,
      });
    } finally {
      await this.cleanupTempFile(tempFile);
    }
  }

  private async executeTask(
    taskName: string,
    _inputs: Record<string, string>,
    _env: Record<string, string>,
  ): Promise<StepResult> {
    return {
      status: 'failed',
      exitCode: 1,
      stdout: '',
      stderr: `Task execution is not yet implemented. Task "${taskName}" cannot be run in this version of piperun.`,
      duration: 0,
      outputs: {},
      retryCount: 0,
    };
  }

  private async spawnProcess(spawnOpts: InternalSpawnOptions): Promise<StepResult> {
    const startTime = Date.now();
    const outputs: Record<string, string> = {};
    let stdout = '';
    let stderr = '';

    return new Promise<StepResult>((resolve) => {
      const abortController = new AbortController();
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (spawnOpts.timeoutMs && spawnOpts.timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          timedOut = true;
          abortController.abort();
        }, spawnOpts.timeoutMs);
      }

      let child: ChildProcess;
      try {
        child = spawn(spawnOpts.command, spawnOpts.args, {
          cwd: spawnOpts.cwd,
          env: { ...process.env, ...spawnOpts.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: abortController.signal,
        });
      } catch (spawnError: unknown) {
        if (timeoutId) clearTimeout(timeoutId);
        const errMsg =
          spawnError instanceof Error ? spawnError.message : String(spawnError);
        resolve({
          status: 'failed',
          exitCode: 1,
          stdout: '',
          stderr: `Failed to spawn process: ${errMsg}`,
          duration: Date.now() - startTime,
          outputs: {},
          retryCount: 0,
        });
        return;
      }

      const processStdoutLines = (readable: Readable): void => {
        const rl = createInterface({ input: readable, crlfDelay: Infinity });
        rl.on('line', (rawLine: string) => {
          // Check for logging commands before masking
          const parsed = parseLoggingCommand(rawLine);
          if (parsed) {
            this.options.onLoggingCommand?.(
              parsed.command,
              parsed.properties,
              parsed.value,
            );
            // Handle setvariable inline — capture outputs
            if (parsed.command === 'setvariable' && parsed.properties['variable']) {
              outputs[parsed.properties['variable']] = parsed.value;
            }
          }
          const maskedLine = this.options.secretMasker.mask(rawLine);
          stdout += maskedLine + '\n';
          this.options.onOutput?.(maskedLine, 'stdout');
        });
      };

      const processStderrLines = (readable: Readable): void => {
        const rl = createInterface({ input: readable, crlfDelay: Infinity });
        rl.on('line', (rawLine: string) => {
          const maskedLine = this.options.secretMasker.mask(rawLine);
          stderr += maskedLine + '\n';
          this.options.onOutput?.(maskedLine, 'stderr');
        });
      };

      if (child.stdout) processStdoutLines(child.stdout);
      if (child.stderr) processStderrLines(child.stderr);

      child.on('error', (err: Error) => {
        if (timeoutId) clearTimeout(timeoutId);
        const duration = Date.now() - startTime;
        // ABORT_ERR is thrown when the signal fires
        const status: PipelineStatus = timedOut ? 'failed' : 'failed';
        const errMessage = timedOut
          ? `Process timed out after ${spawnOpts.timeoutMs}ms`
          : `Process error: ${err.message}`;
        stderr += errMessage + '\n';
        resolve({
          status,
          exitCode: 1,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          duration,
          outputs,
          retryCount: 0,
        });
      });

      child.on('close', (exitCode: number | null) => {
        if (timeoutId) clearTimeout(timeoutId);
        const duration = Date.now() - startTime;

        if (timedOut) {
          resolve({
            status: 'failed',
            exitCode: 1,
            stdout: stdout.trimEnd(),
            stderr: (stderr + `Process timed out after ${spawnOpts.timeoutMs}ms`).trimEnd(),
            duration,
            outputs,
            retryCount: 0,
          });
          return;
        }

        const code = exitCode ?? 1;
        const status: PipelineStatus = code === 0 ? 'succeeded' : 'failed';

        resolve({
          status,
          exitCode: code,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          duration,
          outputs,
          retryCount: 0,
        });
      });
    });
  }

  // ─── Temp file helpers ──────────────────────────────────────────────────

  private async writeTempFile(content: string, extension: string): Promise<string> {
    const suffix = randomBytes(8).toString('hex');
    const dir = await mkdtemp(join(tmpdir(), 'piperun-'));
    const filePath = join(dir, `step-${suffix}${extension}`);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  private async cleanupTempFile(filePath: string): Promise<void> {
    try {
      await unlink(filePath);
    } catch {
      // Best-effort cleanup — file may already be gone
    }
  }
}
