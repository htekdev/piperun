import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactManager } from '../../src/artifacts/artifact-manager.js';

describe('ArtifactManager', () => {
  let tempDir: string;
  let manager: ArtifactManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'piperun-artifact-test-'));
    manager = new ArtifactManager(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('publishes a file artifact', async () => {
    // Create a source file
    const sourceDir = join(tempDir, 'source');
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, 'output.txt');
    await writeFile(sourceFile, 'build output content', 'utf-8');

    const artifactPath = await manager.publish({
      name: 'build-output',
      sourcePath: sourceFile,
      runId: 'run-001',
    });

    // Verify the file was copied
    const copiedContent = await readFile(
      join(artifactPath, 'output.txt'),
      'utf-8',
    );
    expect(copiedContent).toBe('build output content');
  });

  it('publishes a directory artifact', async () => {
    // Create source directory with files
    const sourceDir = join(tempDir, 'source-dir');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'file1.txt'), 'content 1', 'utf-8');
    await writeFile(join(sourceDir, 'file2.txt'), 'content 2', 'utf-8');

    const artifactPath = await manager.publish({
      name: 'multi-file',
      sourcePath: sourceDir,
      runId: 'run-002',
    });

    const f1 = await readFile(join(artifactPath, 'file1.txt'), 'utf-8');
    const f2 = await readFile(join(artifactPath, 'file2.txt'), 'utf-8');
    expect(f1).toBe('content 1');
    expect(f2).toBe('content 2');
  });

  it('lists artifacts for a run', async () => {
    // Publish two artifacts
    const srcDir = join(tempDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const srcFile = join(srcDir, 'data.json');
    await writeFile(srcFile, '{"key":"value"}', 'utf-8');

    await manager.publish({
      name: 'artifact-a',
      sourcePath: srcFile,
      runId: 'run-003',
    });
    await manager.publish({
      name: 'artifact-b',
      sourcePath: srcFile,
      runId: 'run-003',
    });

    const artifacts = await manager.listArtifacts('run-003');
    expect(artifacts).toHaveLength(2);

    const names = artifacts.map((a) => a.name).sort();
    expect(names).toEqual(['artifact-a', 'artifact-b']);

    // Each artifact should have a size > 0
    for (const artifact of artifacts) {
      expect(artifact.size).toBeGreaterThan(0);
      expect(artifact.path).toContain('run-003');
    }
  });

  it('returns empty array for nonexistent run', async () => {
    const artifacts = await manager.listArtifacts('nonexistent-run');
    expect(artifacts).toEqual([]);
  });

  it('downloads artifact to target path', async () => {
    // Publish an artifact first
    const srcDir = join(tempDir, 'src');
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, 'report.html'), '<h1>Report</h1>', 'utf-8');

    await manager.publish({
      name: 'report',
      sourcePath: join(srcDir, 'report.html'),
      runId: 'run-004',
    });

    // Download it to a different location
    const downloadTarget = join(tempDir, 'downloaded');
    await manager.download('run-004', 'report', downloadTarget);

    const content = await readFile(
      join(downloadTarget, 'report.html'),
      'utf-8',
    );
    expect(content).toBe('<h1>Report</h1>');
  });

  it('computes artifact path correctly', () => {
    const path = manager.getArtifactPath('run-xyz', 'my-artifact');
    expect(path).toContain('run-xyz');
    expect(path).toContain('artifacts');
    expect(path).toContain('my-artifact');
  });
});
