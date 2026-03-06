import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CacheManager } from '../../src/artifacts/cache-manager.js';

describe('CacheManager', () => {
  let tempDir: string;
  let cacheDir: string;
  let workDir: string;
  let manager: CacheManager;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'piperun-cache-test-'));
    cacheDir = join(tempDir, 'cache');
    workDir = join(tempDir, 'work');
    await mkdir(cacheDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    manager = new CacheManager(cacheDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('computes key from literal strings', async () => {
    const key = await manager.computeKey('npm | Linux | v1', workDir);
    expect(key).toBe('npm-Linux-v1');
  });

  it('computes key with file glob (hashes file contents)', async () => {
    // Create a file that matches a glob pattern
    await writeFile(join(workDir, 'package-lock.json'), '{"lockfileVersion":3}', 'utf-8');

    const key1 = await manager.computeKey(
      'npm | **/package-lock.json',
      workDir,
    );
    expect(key1).toContain('npm-');
    // The second part should be a hex hash
    const parts = key1.split('-');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe('npm');
    expect(parts[1]).toMatch(/^[0-9a-f]{16}$/);

    // Different content should produce a different key
    await writeFile(join(workDir, 'package-lock.json'), '{"lockfileVersion":4,"changed":true}', 'utf-8');
    const key2 = await manager.computeKey(
      'npm | **/package-lock.json',
      workDir,
    );
    expect(key2).not.toBe(key1);
  });

  it('saves and restores cache (round-trip)', async () => {
    // Create files to cache
    const dataDir = join(workDir, 'node_data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'dep.txt'), 'cached dependency', 'utf-8');

    const cacheKey = 'test-roundtrip-key';
    await manager.save(cacheKey, [dataDir]);

    // Remove original files
    await rm(dataDir, { recursive: true, force: true });

    // Restore
    const hit = await manager.restore(cacheKey, [dataDir]);
    expect(hit).toBe(true);

    // Verify restored content
    const content = await readFile(join(dataDir, 'dep.txt'), 'utf-8');
    expect(content).toBe('cached dependency');
  });

  it('cache miss returns false', async () => {
    const hit = await manager.restore('nonexistent-key', [
      join(workDir, 'nothing'),
    ]);
    expect(hit).toBe(false);
  });

  it('restores with fallback keys (prefix matching)', async () => {
    // Save something with a specific key
    const fileToCache = join(workDir, 'cached-file.txt');
    await writeFile(fileToCache, 'fallback content', 'utf-8');

    await manager.save('npm-linux-abc123', [fileToCache]);

    // Remove original
    await rm(fileToCache, { force: true });

    // Try an exact key that doesn't exist, then fallback to prefix
    const result = await manager.restoreWithFallback(
      'npm-linux-zzz999', // exact key — miss
      ['npm-linux'], // fallback prefix — should match npm-linux-abc123
      [fileToCache],
    );

    expect(result.hit).toBe(true);
    expect(result.matchedKey).toBe('npm-linux-abc123');

    const content = await readFile(fileToCache, 'utf-8');
    expect(content).toBe('fallback content');
  });

  it('restoreWithFallback returns miss when no key matches', async () => {
    const result = await manager.restoreWithFallback(
      'nonexistent-exact',
      ['also-nonexistent'],
      [join(workDir, 'nothing')],
    );
    expect(result.hit).toBe(false);
    expect(result.matchedKey).toBeUndefined();
  });

  it('lists cache entries', async () => {
    const f1 = join(workDir, 'f1.txt');
    const f2 = join(workDir, 'f2.txt');
    await writeFile(f1, 'file 1 content', 'utf-8');
    await writeFile(f2, 'file 2 content with more data', 'utf-8');

    await manager.save('entry-alpha', [f1]);
    await manager.save('entry-beta', [f2]);

    const entries = await manager.listEntries();
    expect(entries).toHaveLength(2);

    const keys = entries.map((e) => e.key).sort();
    expect(keys).toEqual(['entry-alpha', 'entry-beta']);

    for (const entry of entries) {
      expect(entry.size).toBeGreaterThan(0);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.paths).toBeInstanceOf(Array);
    }
  });

  it('clears all cache', async () => {
    const f = join(workDir, 'to-cache.txt');
    await writeFile(f, 'data', 'utf-8');
    await manager.save('clear-test', [f]);

    // Verify cache exists
    let entries = await manager.listEntries();
    expect(entries).toHaveLength(1);

    // Clear
    await manager.clear();

    // Verify cache is empty
    entries = await manager.listEntries();
    expect(entries).toHaveLength(0);
  });
});
