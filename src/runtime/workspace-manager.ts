// Workspace manager — manage per-run workspace directories.

import { mkdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceInfo {
  /** Root directory for the run */
  rootDir: string;
  /** Source directory (s/) */
  sourceDir: string;
  /** Binaries / outputs directory (b/) */
  binariesDir: string;
  /** Artifacts staging directory (a/) */
  artifactsDir: string;
  /** Temp directory (tmp/) */
  tempDir: string;
}

/**
 * Create, query, and clean workspaces for pipeline runs.
 *
 * Layout:
 * ```
 * {baseDir}/{runId}/
 *   s/     — source
 *   b/     — binaries/outputs
 *   a/     — artifacts staging
 *   tmp/   — temp files
 * ```
 */
export class WorkspaceManager {
  constructor(private readonly baseDir: string) {}

  /** Initialise a workspace for a run, creating all subdirectories. */
  async initialize(runId: string): Promise<WorkspaceInfo> {
    const ws = this.getWorkspace(runId);

    await mkdir(ws.sourceDir, { recursive: true });
    await mkdir(ws.binariesDir, { recursive: true });
    await mkdir(ws.artifactsDir, { recursive: true });
    await mkdir(ws.tempDir, { recursive: true });

    return ws;
  }

  /** Clean parts of the workspace. */
  async clean(
    workspace: WorkspaceInfo,
    cleanOption: 'outputs' | 'resources' | 'all',
  ): Promise<void> {
    switch (cleanOption) {
      case 'outputs':
        // Clean binaries and artifacts
        await this.rmIfExists(workspace.binariesDir);
        await this.rmIfExists(workspace.artifactsDir);
        await mkdir(workspace.binariesDir, { recursive: true });
        await mkdir(workspace.artifactsDir, { recursive: true });
        break;

      case 'resources':
        // Clean source
        await this.rmIfExists(workspace.sourceDir);
        await mkdir(workspace.sourceDir, { recursive: true });
        break;

      case 'all':
        // Clean everything
        await this.rmIfExists(workspace.rootDir);
        await mkdir(workspace.sourceDir, { recursive: true });
        await mkdir(workspace.binariesDir, { recursive: true });
        await mkdir(workspace.artifactsDir, { recursive: true });
        await mkdir(workspace.tempDir, { recursive: true });
        break;
    }
  }

  /** Get workspace info for a run without creating directories. */
  getWorkspace(runId: string): WorkspaceInfo {
    const rootDir = join(this.baseDir, runId);
    return {
      rootDir,
      sourceDir: join(rootDir, 's'),
      binariesDir: join(rootDir, 'b'),
      artifactsDir: join(rootDir, 'a'),
      tempDir: join(rootDir, 'tmp'),
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async rmIfExists(dir: string): Promise<void> {
    try {
      await access(dir);
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist — nothing to clean
    }
  }
}
