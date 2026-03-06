import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PoolResolver } from '../../src/runtime/pool-resolver.js';
import { WorkspaceManager } from '../../src/runtime/workspace-manager.js';
import type { PoolDefinition } from '../../src/types/pipeline.js';

// ─── PoolResolver ───────────────────────────────────────────────────────────────

describe('PoolResolver', () => {
  let resolver: PoolResolver;

  beforeEach(() => {
    resolver = new PoolResolver();
  });

  describe('vmImage mapping', () => {
    it('maps ubuntu-latest to ubuntu:latest', () => {
      expect(resolver.mapVmImage('ubuntu-latest')).toBe('ubuntu:latest');
    });

    it('maps ubuntu-22.04 to ubuntu:22.04', () => {
      expect(resolver.mapVmImage('ubuntu-22.04')).toBe('ubuntu:22.04');
    });

    it('maps windows-latest to servercore image', () => {
      expect(resolver.mapVmImage('windows-latest')).toBe(
        'mcr.microsoft.com/windows/servercore:ltsc2022',
      );
    });

    it('maps macos-latest to macos:latest', () => {
      expect(resolver.mapVmImage('macos-latest')).toBe('macos:latest');
    });

    it('returns undefined for unknown vmImage', () => {
      expect(resolver.mapVmImage('freebsd-latest')).toBeUndefined();
    });
  });

  describe('pool resolution', () => {
    it('resolves undefined pool to local default', () => {
      const result = resolver.resolvePool(undefined);
      expect(result.type).toBe('local');
      expect(result.name).toBe('default');
      expect(result.demands).toEqual([]);
    });

    it('resolves string pool name to local type', () => {
      const pool: PoolDefinition = { name: 'my-pool' };
      const result = resolver.resolvePool(pool);
      expect(result.type).toBe('local');
      expect(result.name).toBe('my-pool');
    });

    it('resolves vmImage pool to container type', () => {
      const pool: PoolDefinition = { vmImage: 'ubuntu-latest' };
      const result = resolver.resolvePool(pool);
      expect(result.type).toBe('container');
      expect(result.name).toBe('ubuntu-latest');
      expect(result.image).toBe('ubuntu:latest');
    });

    it('resolves vmImage pool with unknown image using original name', () => {
      const pool: PoolDefinition = { vmImage: 'custom-image:v1' };
      const result = resolver.resolvePool(pool);
      expect(result.type).toBe('container');
      expect(result.image).toBe('custom-image:v1');
    });

    it('includes demands from pool definition', () => {
      const pool: PoolDefinition = {
        name: 'my-pool',
        demands: ['node', 'docker'],
      };
      const result = resolver.resolvePool(pool);
      expect(result.demands).toEqual(['node', 'docker']);
    });

    it('normalizes string demands to array', () => {
      const pool: PoolDefinition = {
        name: 'my-pool',
        demands: 'node',
      };
      const result = resolver.resolvePool(pool);
      expect(result.demands).toEqual(['node']);
    });
  });

  describe('demands validation', () => {
    it('marks node as satisfied (should be available in test env)', () => {
      const result = resolver.validateDemands(['node']);
      expect(result.satisfied).toBe(true);
      expect(result.missing).toHaveLength(0);
    });

    it('marks a non-existent tool as missing', () => {
      const result = resolver.validateDemands(['__piperun_nonexistent_tool_xyz__']);
      expect(result.satisfied).toBe(false);
      expect(result.missing).toContain('__piperun_nonexistent_tool_xyz__');
    });

    it('validates Agent.OS demand against current platform', () => {
      const currentOS = process.platform === 'win32' ? 'Windows_NT' : process.platform === 'darwin' ? 'Darwin' : 'Linux';
      const result = resolver.validateDemands([`Agent.OS -equals ${currentOS}`]);
      expect(result.satisfied).toBe(true);
    });

    it('fails Agent.OS demand for wrong platform', () => {
      const result = resolver.validateDemands(['Agent.OS -equals FakeOS']);
      expect(result.satisfied).toBe(false);
      expect(result.missing).toContain('Agent.OS -equals FakeOS');
    });

    it('reports all missing demands', () => {
      const result = resolver.validateDemands([
        'node',
        '__missing1__',
        '__missing2__',
      ]);
      expect(result.missing).toEqual(['__missing1__', '__missing2__']);
    });
  });

  describe('checkCapabilities', () => {
    it('returns Agent.OS capability', async () => {
      const caps = await resolver.checkCapabilities();
      expect(caps['Agent.OS']).toBeTruthy();
      expect(['Windows_NT', 'Darwin', 'Linux']).toContain(caps['Agent.OS']);
    });

    it('detects node as a capability', async () => {
      const caps = await resolver.checkCapabilities();
      expect(caps['node']).toBeTruthy();
    });
  });
});

// ─── WorkspaceManager ───────────────────────────────────────────────────────────

describe('WorkspaceManager', () => {
  let tmpDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'piperun-workspace-'));
    manager = new WorkspaceManager(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('creates workspace directories', async () => {
      const ws = await manager.initialize('run-1');

      await expect(access(ws.sourceDir)).resolves.toBeUndefined();
      await expect(access(ws.binariesDir)).resolves.toBeUndefined();
      await expect(access(ws.artifactsDir)).resolves.toBeUndefined();
      await expect(access(ws.tempDir)).resolves.toBeUndefined();
    });

    it('returns correct workspace paths', async () => {
      const ws = await manager.initialize('run-42');

      expect(ws.rootDir).toBe(join(tmpDir, 'run-42'));
      expect(ws.sourceDir).toBe(join(tmpDir, 'run-42', 's'));
      expect(ws.binariesDir).toBe(join(tmpDir, 'run-42', 'b'));
      expect(ws.artifactsDir).toBe(join(tmpDir, 'run-42', 'a'));
      expect(ws.tempDir).toBe(join(tmpDir, 'run-42', 'tmp'));
    });
  });

  describe('getWorkspace', () => {
    it('returns workspace info without creating directories', () => {
      const ws = manager.getWorkspace('run-1');
      expect(ws.rootDir).toBe(join(tmpDir, 'run-1'));
    });
  });

  describe('clean', () => {
    it('cleans outputs (binaries and artifacts)', async () => {
      const ws = await manager.initialize('run-1');

      // Write marker files
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(ws.binariesDir, 'out.txt'), 'data');
      await writeFile(join(ws.artifactsDir, 'artifact.txt'), 'data');
      await writeFile(join(ws.sourceDir, 'source.txt'), 'data');

      await manager.clean(ws, 'outputs');

      // Binaries and artifacts dirs should be empty
      const bFiles = await readdir(ws.binariesDir);
      expect(bFiles).toHaveLength(0);
      const aFiles = await readdir(ws.artifactsDir);
      expect(aFiles).toHaveLength(0);

      // Source should be untouched
      await expect(access(join(ws.sourceDir, 'source.txt'))).resolves.toBeUndefined();
    });

    it('cleans resources (source)', async () => {
      const ws = await manager.initialize('run-1');

      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(ws.sourceDir, 'source.txt'), 'data');
      await writeFile(join(ws.binariesDir, 'out.txt'), 'data');

      await manager.clean(ws, 'resources');

      // Source should be empty
      const sFiles = await readdir(ws.sourceDir);
      expect(sFiles).toHaveLength(0);

      // Binaries should be untouched
      await expect(access(join(ws.binariesDir, 'out.txt'))).resolves.toBeUndefined();
    });

    it('cleans all directories', async () => {
      const ws = await manager.initialize('run-1');

      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(ws.sourceDir, 'source.txt'), 'data');
      await writeFile(join(ws.binariesDir, 'out.txt'), 'data');
      await writeFile(join(ws.artifactsDir, 'artifact.txt'), 'data');
      await writeFile(join(ws.tempDir, 'temp.txt'), 'data');

      await manager.clean(ws, 'all');

      // All dirs should exist but be empty
      expect(await readdir(ws.sourceDir)).toHaveLength(0);
      expect(await readdir(ws.binariesDir)).toHaveLength(0);
      expect(await readdir(ws.artifactsDir)).toHaveLength(0);
      expect(await readdir(ws.tempDir)).toHaveLength(0);
    });
  });
});
