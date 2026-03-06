// Manual approval — interactive CLI prompt for deployment gates.

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { userInfo } from 'node:os';
import type { Writable } from 'node:stream';

export interface ApprovalRequest {
  environment: string;
  pipelineName: string;
  stageName: string;
  message?: string;
  /** Timeout in minutes; default 60 */
  timeoutMinutes?: number;
}

export interface ApprovalResult {
  approved: boolean;
  approver: string;
  timestamp: string;
  comment?: string;
}

export interface ManualApprovalOptions {
  readlineInterface?: ReadlineInterface;
  output?: Writable;
}

/**
 * Prompt the user for a manual approval via the CLI.
 *
 * Supports dependency-injection of a readline interface and output stream
 * for testing. When nothing is provided it defaults to stdin/stdout.
 */
export class ManualApproval {
  private readonly rl: ReadlineInterface;
  private readonly output: Writable;
  private readonly ownsRl: boolean;

  constructor(options?: ManualApprovalOptions | ReadlineInterface) {
    if (options && 'question' in options) {
      // Legacy: direct ReadlineInterface argument
      this.rl = options;
      this.output = process.stdout;
      this.ownsRl = false;
    } else if (options && 'readlineInterface' in options && options.readlineInterface) {
      this.rl = options.readlineInterface;
      this.output = options.output ?? process.stdout;
      this.ownsRl = false;
    } else {
      this.rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      this.output = (options as ManualApprovalOptions | undefined)?.output ?? process.stdout;
      this.ownsRl = true;
    }
  }

  /** Display approval info and prompt the user. Returns the result. */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const timeoutMs = (request.timeoutMinutes ?? 60) * 60 * 1000;
    const approver = userInfo().username;

    // Display request information
    this.writeLine('');
    this.writeLine('┌──────────────────────────────────────────┐');
    this.writeLine('│         APPROVAL REQUIRED                │');
    this.writeLine('├──────────────────────────────────────────┤');
    this.writeLine(`│  Pipeline:    ${request.pipelineName}`);
    this.writeLine(`│  Stage:       ${request.stageName}`);
    this.writeLine(`│  Environment: ${request.environment}`);
    if (request.message) {
      this.writeLine(`│  Message:     ${request.message}`);
    }
    this.writeLine('└──────────────────────────────────────────┘');

    try {
      const answer = await this.promptWithTimeout(
        'Continue? [y/n]: ',
        timeoutMs,
      );
      const approved = answer.trim().toLowerCase() === 'y';

      return {
        approved,
        approver,
        timestamp: new Date().toISOString(),
        comment: approved ? undefined : 'Rejected by user',
      };
    } catch {
      // Timeout or error → auto-reject
      return {
        approved: false,
        approver,
        timestamp: new Date().toISOString(),
        comment: 'Approval timed out',
      };
    } finally {
      if (this.ownsRl) {
        this.rl.close();
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private writeLine(text: string): void {
    this.output.write(text + '\n');
  }

  /** Prompt with a timeout. Rejects if the timeout elapses. */
  private promptWithTimeout(
    question: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Approval timed out'));
      }, timeoutMs);

      this.rl.question(question, (answer: string) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }
}
