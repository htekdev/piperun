/**
 * Environment manager — tracks deployment environments and their history.
 * Stores deployment records as JSON files at ~/.piperun/environments/{envName}/history.json.
 */

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Public types ───────────────────────────────────────────────────────────

export interface DeploymentRecord {
  runId: string;
  runNumber: number;
  pipelineName: string;
  timestamp: string; // ISO 8601
  status: string;
  strategy: string;
  duration: number;
}

export interface EnvironmentInfo {
  name: string;
  deployments: DeploymentRecord[];
}

// ─── EnvironmentManager class ───────────────────────────────────────────────

export class EnvironmentManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir =
      baseDir ?? join(homedir(), '.piperun', 'environments');
  }

  /**
   * Record a deployment to an environment.
   * Appends the record to the environment's history.json file.
   */
  async recordDeployment(
    environment: string,
    record: DeploymentRecord,
  ): Promise<void> {
    const envDir = this.getEnvironmentDir(environment);
    await mkdir(envDir, { recursive: true });

    const historyPath = join(envDir, 'history.json');
    const existing = await this.readHistoryFile(historyPath);
    existing.push(record);

    await writeFile(historyPath, JSON.stringify(existing, null, 2), 'utf-8');
  }

  /**
   * Get deployment history for an environment.
   * Returns records in reverse chronological order (newest first).
   */
  async getHistory(
    environment: string,
    limit?: number,
  ): Promise<DeploymentRecord[]> {
    const historyPath = join(
      this.getEnvironmentDir(environment),
      'history.json',
    );
    const records = await this.readHistoryFile(historyPath);

    // Sort newest first by timestamp
    records.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    if (limit !== undefined && limit > 0) {
      return records.slice(0, limit);
    }

    return records;
  }

  /**
   * Get all known environments by listing directories under the base path.
   */
  async listEnvironments(): Promise<string[]> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      // Directory doesn't exist yet — no environments recorded
      return [];
    }
  }

  /**
   * Get the latest deployment for an environment.
   * Returns the most recent record by timestamp, or null if no deployments exist.
   */
  async getLatestDeployment(
    environment: string,
  ): Promise<DeploymentRecord | null> {
    const history = await this.getHistory(environment, 1);
    return history.length > 0 ? history[0] : null;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private getEnvironmentDir(environment: string): string {
    return join(this.baseDir, environment);
  }

  private async readHistoryFile(path: string): Promise<DeploymentRecord[]> {
    try {
      const content = await readFile(path, 'utf-8');
      const parsed: unknown = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed as DeploymentRecord[];
      }
      return [];
    } catch {
      // File doesn't exist or is invalid — start fresh
      return [];
    }
  }
}
