import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { ExclusiveLock } from '../../src/approvals/exclusive-lock.js';
import type { LockInfo } from '../../src/approvals/exclusive-lock.js';
import { ManualApproval } from '../../src/approvals/manual-approval.js';

// ─── ExclusiveLock ──────────────────────────────────────────────────────────────

describe('ExclusiveLock', () => {
  let tmpDir: string;
  let lock: ExclusiveLock;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'piperun-lock-'));
    lock = new ExclusiveLock(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const makeLockInfo = (runId: string): LockInfo => ({
    runId,
    pipelineName: 'test-pipeline',
    lockedAt: new Date().toISOString(),
    lockedBy: 'testuser',
  });

  describe('acquire and release', () => {
    it('acquires a lock on a free environment', async () => {
      const info = makeLockInfo('run-1');
      const acquired = await lock.acquire('production', info);
      expect(acquired).toBe(true);
    });

    it('fails to acquire when already locked', async () => {
      const info1 = makeLockInfo('run-1');
      const info2 = makeLockInfo('run-2');

      await lock.acquire('production', info1);
      const acquired = await lock.acquire('production', info2);
      expect(acquired).toBe(false);
    });

    it('releases a lock held by the same runId', async () => {
      const info = makeLockInfo('run-1');
      await lock.acquire('staging', info);

      const released = await lock.release('staging', 'run-1');
      expect(released).toBe(true);

      const locked = await lock.isLocked('staging');
      expect(locked).toBeNull();
    });

    it('refuses to release a lock held by a different runId', async () => {
      const info = makeLockInfo('run-1');
      await lock.acquire('staging', info);

      const released = await lock.release('staging', 'run-other');
      expect(released).toBe(false);
    });

    it('returns false when releasing a non-existent lock', async () => {
      const released = await lock.release('noenv', 'run-1');
      expect(released).toBe(false);
    });
  });

  describe('lock detection', () => {
    it('returns lock info for a locked environment', async () => {
      const info = makeLockInfo('run-1');
      await lock.acquire('production', info);

      const locked = await lock.isLocked('production');
      expect(locked).not.toBeNull();
      expect(locked!.runId).toBe('run-1');
      expect(locked!.pipelineName).toBe('test-pipeline');
    });

    it('returns null for an unlocked environment', async () => {
      const locked = await lock.isLocked('production');
      expect(locked).toBeNull();
    });
  });

  describe('sequential wait behavior', () => {
    it('acquires lock when environment is free', async () => {
      const info = makeLockInfo('run-1');
      const acquired = await lock.waitForLock('prod', info, 2000, 'sequential');
      expect(acquired).toBe(true);
    });

    it('acquires lock after it is released', async () => {
      const info1 = makeLockInfo('run-1');
      const info2 = makeLockInfo('run-2');

      await lock.acquire('prod', info1);

      // Release after a short delay
      setTimeout(async () => {
        await lock.release('prod', 'run-1');
      }, 300);

      const acquired = await lock.waitForLock('prod', info2, 3000, 'sequential');
      expect(acquired).toBe(true);

      const locked = await lock.isLocked('prod');
      expect(locked!.runId).toBe('run-2');
    });
  });

  describe('runLatest force-acquire', () => {
    it('force-acquires when the existing lock is from an older run', async () => {
      const olderInfo: LockInfo = {
        runId: 'run-old',
        pipelineName: 'test-pipeline',
        lockedAt: new Date(Date.now() - 10000).toISOString(),
        lockedBy: 'testuser',
      };

      const newerInfo: LockInfo = {
        runId: 'run-new',
        pipelineName: 'test-pipeline',
        lockedAt: new Date().toISOString(),
        lockedBy: 'testuser',
      };

      await lock.acquire('prod', olderInfo);

      const acquired = await lock.waitForLock('prod', newerInfo, 2000, 'runLatest');
      expect(acquired).toBe(true);

      const locked = await lock.isLocked('prod');
      expect(locked!.runId).toBe('run-new');
    });
  });

  describe('timeout on wait', () => {
    it('returns false when lock is not released within timeout', async () => {
      const info1 = makeLockInfo('run-1');
      const info2 = makeLockInfo('run-2');

      await lock.acquire('prod', info1);

      const acquired = await lock.waitForLock('prod', info2, 800, 'sequential');
      expect(acquired).toBe(false);
    });
  });

  describe('lock file content', () => {
    it('persists lock info as valid JSON', async () => {
      const info = makeLockInfo('run-42');
      await lock.acquire('staging', info);

      const content = await readFile(join(tmpDir, 'staging.lock.json'), 'utf-8');
      const parsed = JSON.parse(content) as LockInfo;
      expect(parsed.runId).toBe('run-42');
      expect(parsed.pipelineName).toBe('test-pipeline');
    });
  });
});

// ─── ManualApproval ─────────────────────────────────────────────────────────────

describe('ManualApproval', () => {
  /** Create a fake readline interface + capture output. */
  function createMockReadline(answer: string) {
    const inputStream = new Readable({
      read() {
        this.push(answer + '\n');
        this.push(null);
      },
    });

    const chunks: Buffer[] = [];
    const outputStream = new Writable({
      write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
        chunks.push(chunk);
        callback();
      },
    });

    const rl = createInterface({
      input: inputStream,
      output: outputStream,
    });

    return {
      rl,
      outputStream,
      getOutput: () => Buffer.concat(chunks).toString(),
    };
  }

  it('returns approved=true when user answers "y"', async () => {
    const { rl, outputStream } = createMockReadline('y');
    const approval = new ManualApproval({ readlineInterface: rl, output: outputStream });

    const result = await approval.requestApproval({
      environment: 'production',
      pipelineName: 'deploy-app',
      stageName: 'Deploy',
    });

    expect(result.approved).toBe(true);
    expect(result.approver).toBeTruthy();
    expect(result.timestamp).toBeTruthy();
  });

  it('returns approved=false when user answers "n"', async () => {
    const { rl, outputStream } = createMockReadline('n');
    const approval = new ManualApproval({ readlineInterface: rl, output: outputStream });

    const result = await approval.requestApproval({
      environment: 'production',
      pipelineName: 'deploy-app',
      stageName: 'Deploy',
    });

    expect(result.approved).toBe(false);
    expect(result.comment).toBe('Rejected by user');
  });

  it('returns approved=false for any non-"y" answer', async () => {
    const { rl, outputStream } = createMockReadline('maybe');
    const approval = new ManualApproval({ readlineInterface: rl, output: outputStream });

    const result = await approval.requestApproval({
      environment: 'staging',
      pipelineName: 'deploy-app',
      stageName: 'Deploy',
    });

    expect(result.approved).toBe(false);
  });

  it('includes the approval message in the display output', async () => {
    const { rl, outputStream, getOutput } = createMockReadline('y');
    const approval = new ManualApproval({ readlineInterface: rl, output: outputStream });

    await approval.requestApproval({
      environment: 'production',
      pipelineName: 'deploy-app',
      stageName: 'Deploy',
      message: 'Please approve the production deployment',
    });

    const output = getOutput();
    expect(output).toContain('production');
    expect(output).toContain('deploy-app');
    expect(output).toContain('Deploy');
    expect(output).toContain('Please approve the production deployment');
  });

  it('auto-rejects after timeout', async () => {
    // Create a stream that never provides input
    const inputStream = new Readable({ read() {} });
    const outputStream = new Writable({
      write(_chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
        callback();
      },
    });
    const rl = createInterface({ input: inputStream, output: outputStream });
    const approval = new ManualApproval({ readlineInterface: rl, output: outputStream });

    const result = await approval.requestApproval({
      environment: 'production',
      pipelineName: 'deploy-app',
      stageName: 'Deploy',
      timeoutMinutes: 0.001, // ~60ms
    });

    expect(result.approved).toBe(false);
    expect(result.comment).toBe('Approval timed out');

    rl.close();
  }, 10000);
});
