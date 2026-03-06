// Exclusive lock — file-based mutex for exclusive deployment locks.

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface LockInfo {
  runId: string;
  pipelineName: string;
  lockedAt: string;
  lockedBy: string;
}

/**
 * File-based exclusive lock for deployment environments.
 *
 * Uses atomic write-then-rename to minimise race-window.
 * Lock files live at `{lockDir}/{environment}.lock.json`.
 */
export class ExclusiveLock {
  private readonly lockDir: string;

  constructor(lockDir?: string) {
    this.lockDir = lockDir ?? join(homedir(), '.piperun', 'locks');
  }

  /** Attempt to acquire a lock. Returns true on success. */
  async acquire(environment: string, info: LockInfo): Promise<boolean> {
    await this.ensureDir();

    const existing = await this.isLocked(environment);
    if (existing) {
      return false;
    }

    await this.writeLock(environment, info);
    return true;
  }

  /** Release a lock, but only if it's held by the given runId. */
  async release(environment: string, runId: string): Promise<boolean> {
    const existing = await this.isLocked(environment);
    if (!existing) {
      return false;
    }
    if (existing.runId !== runId) {
      return false;
    }

    const lockFile = this.lockPath(environment);
    try {
      await unlink(lockFile);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if an environment is locked. Returns the lock info or null. */
  async isLocked(environment: string): Promise<LockInfo | null> {
    const lockFile = this.lockPath(environment);
    try {
      const content = await readFile(lockFile, 'utf-8');
      return JSON.parse(content) as LockInfo;
    } catch {
      return null;
    }
  }

  /**
   * Wait for the lock to become available (with timeout).
   *
   * @param environment  Target environment name
   * @param info         Lock info for the caller
   * @param timeoutMs    Max time to wait in milliseconds
   * @param behavior     `sequential` — poll until free; `runLatest` — force-acquire if current lock is older
   * @returns true if the lock was acquired
   */
  async waitForLock(
    environment: string,
    info: LockInfo,
    timeoutMs: number,
    behavior: 'sequential' | 'runLatest',
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 500;

    while (Date.now() < deadline) {
      const existing = await this.isLocked(environment);

      if (!existing) {
        // Lock is free — take it
        await this.writeLock(environment, info);
        return true;
      }

      if (behavior === 'runLatest') {
        // Force-acquire if the existing lock is from an older (or different) run
        const existingTime = new Date(existing.lockedAt).getTime();
        const ourTime = new Date(info.lockedAt).getTime();
        if (ourTime >= existingTime && existing.runId !== info.runId) {
          await this.writeLock(environment, info);
          return true;
        }
      }

      // Wait before retrying
      await this.sleep(Math.min(pollInterval, deadline - Date.now()));
    }

    return false;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private lockPath(environment: string): string {
    return join(this.lockDir, `${environment}.lock.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.lockDir, { recursive: true });
  }

  /** Atomic write: write to temp file, then rename into place. */
  private async writeLock(environment: string, info: LockInfo): Promise<void> {
    await this.ensureDir();
    const lockFile = this.lockPath(environment);
    const tmpFile = join(this.lockDir, `${environment}.lock.${randomUUID()}.tmp`);
    await writeFile(tmpFile, JSON.stringify(info, null, 2), 'utf-8');
    await rename(tmpFile, lockFile);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }
}
