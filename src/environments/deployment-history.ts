/**
 * Deployment history writer — records run-level deployment history.
 * Stores run history as JSON files at ~/.piperun/runs/{runId}/history.json.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Public types ───────────────────────────────────────────────────────────

export interface RunHistory {
  runId: string;
  runNumber: number;
  pipelineName: string;
  startTime: string;
  endTime: string;
  status: string;
  stages: { name: string; status: string; duration: number }[];
  parameters: Record<string, unknown>;
  deployments: { environment: string; status: string; strategy: string }[];
}

export interface RunListEntry {
  runId: string;
  pipelineName: string;
  status: string;
  startTime: string;
}

// ─── DeploymentHistoryWriter class ──────────────────────────────────────────

export class DeploymentHistoryWriter {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.piperun', 'runs');
  }

  /**
   * Write run history to ~/.piperun/runs/{runId}/history.json.
   */
  async writeRunHistory(history: RunHistory): Promise<void> {
    const runDir = join(this.baseDir, history.runId);
    await mkdir(runDir, { recursive: true });

    const historyPath = join(runDir, 'history.json');
    await writeFile(historyPath, JSON.stringify(history, null, 2), 'utf-8');
  }

  /**
   * Read run history for a given runId.
   * Returns null if no history exists for the runId.
   */
  async readRunHistory(runId: string): Promise<RunHistory | null> {
    const historyPath = join(this.baseDir, runId, 'history.json');

    try {
      const content = await readFile(historyPath, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (parsed !== null && typeof parsed === 'object') {
        return parsed as RunHistory;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * List recent runs by scanning run directories.
   * Returns entries sorted newest first by startTime.
   */
  async listRuns(
    limit?: number,
  ): Promise<RunListEntry[]> {
    let entries: RunListEntry[];

    try {
      const dirEntries = await readdir(this.baseDir, { withFileTypes: true });
      const directories = dirEntries.filter((e) => e.isDirectory());

      const historyPromises = directories.map(async (dir) => {
        const history = await this.readRunHistory(dir.name);
        if (history) {
          return {
            runId: history.runId,
            pipelineName: history.pipelineName,
            status: history.status,
            startTime: history.startTime,
          };
        }
        return null;
      });

      const results = await Promise.all(historyPromises);
      entries = results.filter(
        (r): r is RunListEntry => r !== null,
      );
    } catch {
      // Base directory doesn't exist yet
      return [];
    }

    // Sort newest first
    entries.sort(
      (a, b) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
    );

    if (limit !== undefined && limit > 0) {
      return entries.slice(0, limit);
    }

    return entries;
  }
}
