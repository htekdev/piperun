// Pipeline artifact management — publish, download, and list artifacts.

import { mkdir, cp, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ArtifactPublishOptions {
  name: string;
  sourcePath: string;
  runId: string;
}

export interface ArtifactInfo {
  name: string;
  path: string;
  size: number;
}

export class ArtifactManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.piperun', 'runs');
  }

  /**
   * Publish an artifact by copying files to artifact storage.
   * @returns The artifact storage path.
   */
  async publish(options: ArtifactPublishOptions): Promise<string> {
    const artifactPath = this.getArtifactPath(options.runId, options.name);
    await mkdir(artifactPath, { recursive: true });

    const sourceStats = await stat(options.sourcePath);

    if (sourceStats.isDirectory()) {
      await cp(options.sourcePath, artifactPath, { recursive: true });
    } else {
      // Single file — copy into the artifact directory preserving filename
      const fileName = options.sourcePath.split(/[/\\]/).pop() ?? 'artifact';
      const destPath = join(artifactPath, fileName);
      await cp(options.sourcePath, destPath);
    }

    return artifactPath;
  }

  /**
   * Download/retrieve an artifact to a target path.
   */
  async download(runId: string, artifactName: string, targetPath: string): Promise<void> {
    const artifactPath = this.getArtifactPath(runId, artifactName);
    await mkdir(targetPath, { recursive: true });
    await cp(artifactPath, targetPath, { recursive: true });
  }

  /**
   * List artifacts for a given run.
   */
  async listArtifacts(runId: string): Promise<ArtifactInfo[]> {
    const runArtifactsDir = join(this.baseDir, runId, 'artifacts');

    let entries: string[];
    try {
      entries = await readdir(runArtifactsDir);
    } catch {
      return [];
    }

    const artifacts: ArtifactInfo[] = [];
    for (const entry of entries) {
      const entryPath = join(runArtifactsDir, entry);
      const entryStats = await stat(entryPath);
      if (entryStats.isDirectory()) {
        const size = await this.computeDirectorySize(entryPath);
        artifacts.push({
          name: entry,
          path: entryPath,
          size,
        });
      }
    }

    return artifacts;
  }

  /**
   * Get the storage path for a specific artifact.
   */
  getArtifactPath(runId: string, artifactName: string): string {
    return join(this.baseDir, runId, 'artifacts', artifactName);
  }

  /**
   * Recursively compute the total size of a directory's contents.
   */
  private async computeDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await this.computeDirectorySize(fullPath);
      } else {
        const fileStat = await stat(fullPath);
        totalSize += fileStat.size;
      }
    }

    return totalSize;
  }
}
