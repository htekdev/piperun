// Hash-based pipeline cache management.

import { mkdir, cp, readdir, stat, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export interface CacheEntry {
  key: string;
  paths: string[];
  createdAt: string;
  size: number;
}

interface CacheManifest {
  key: string;
  paths: string[];
  createdAt: string;
}

export class CacheManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.piperun', 'cache');
  }

  /**
   * Compute a cache key from a key specification.
   *
   * Key format: "npm | $(Agent.OS) | ** /package-lock.json"
   * - Pipe-separated segments
   * - Literal strings used as-is
   * - Glob patterns (containing * or ?): hash matched file contents
   */
  async computeKey(keySpec: string, workingDir: string): Promise<string> {
    const segments = keySpec.split(' | ');
    const parts: string[] = [];

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (isGlobPattern(trimmed)) {
        const matchedFiles = await findMatchingFiles(trimmed, workingDir);
        matchedFiles.sort(); // deterministic order
        const hash = createHash('sha256');
        for (const filePath of matchedFiles) {
          const content = await readFile(filePath);
          hash.update(content);
        }
        parts.push(hash.digest('hex').substring(0, 16));
      } else {
        parts.push(trimmed);
      }
    }

    return parts.join('-');
  }

  /**
   * Save paths to cache under a key.
   * Copies each path into the cache directory.
   */
  async save(key: string, paths: string[]): Promise<void> {
    const cacheDir = this.getCacheDir(key);
    await mkdir(cacheDir, { recursive: true });

    for (const sourcePath of paths) {
      let sourceStats;
      try {
        sourceStats = await stat(sourcePath);
      } catch {
        continue; // skip paths that don't exist
      }

      const baseName = sourcePath.split(/[/\\]/).pop() ?? 'cached';
      const destPath = join(cacheDir, baseName);

      if (sourceStats.isDirectory()) {
        await cp(sourcePath, destPath, { recursive: true });
      } else {
        await cp(sourcePath, destPath);
      }
    }

    // Write manifest
    const manifest: CacheManifest = {
      key,
      paths,
      createdAt: new Date().toISOString(),
    };
    const { writeFile: writeFileAsync } = await import('node:fs/promises');
    await writeFileAsync(
      join(cacheDir, '.cache-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  /**
   * Restore cached paths. Returns true if cache hit.
   * Copies cached content back to the original paths.
   */
  async restore(key: string, paths: string[]): Promise<boolean> {
    const cacheDir = this.getCacheDir(key);

    try {
      await stat(cacheDir);
    } catch {
      return false; // cache miss
    }

    for (const targetPath of paths) {
      const baseName = targetPath.split(/[/\\]/).pop() ?? 'cached';
      const cachedPath = join(cacheDir, baseName);

      let cachedStats;
      try {
        cachedStats = await stat(cachedPath);
      } catch {
        continue; // skip if this specific path wasn't cached
      }

      // Ensure parent directory exists
      const parentDir = targetPath.substring(0, targetPath.lastIndexOf('/') > -1 ? targetPath.lastIndexOf('/') : targetPath.lastIndexOf('\\'));
      if (parentDir) {
        await mkdir(parentDir, { recursive: true });
      }

      if (cachedStats.isDirectory()) {
        await cp(cachedPath, targetPath, { recursive: true });
      } else {
        await cp(cachedPath, targetPath);
      }
    }

    return true;
  }

  /**
   * Try restore with fallback keys (prefix matching).
   * First tries the exact key, then tries each restore key as a prefix.
   */
  async restoreWithFallback(
    key: string,
    restoreKeys: string[],
    paths: string[],
  ): Promise<{ hit: boolean; matchedKey?: string }> {
    // Try exact key first
    if (await this.restore(key, paths)) {
      return { hit: true, matchedKey: key };
    }

    // Try fallback keys with prefix matching
    let allEntries: CacheEntry[] | undefined;

    for (const restoreKey of restoreKeys) {
      if (!allEntries) {
        allEntries = await this.listEntries();
      }

      // Find entries whose key starts with the restore key
      const match = allEntries.find((entry) => entry.key.startsWith(restoreKey));
      if (match) {
        const restored = await this.restore(match.key, paths);
        if (restored) {
          return { hit: true, matchedKey: match.key };
        }
      }
    }

    return { hit: false };
  }

  /**
   * List all cache entries.
   */
  async listEntries(): Promise<CacheEntry[]> {
    let dirEntries: string[];
    try {
      dirEntries = await readdir(this.baseDir);
    } catch {
      return [];
    }

    const entries: CacheEntry[] = [];

    for (const dirName of dirEntries) {
      const dirPath = join(this.baseDir, dirName);
      const dirStats = await stat(dirPath);
      if (!dirStats.isDirectory()) continue;

      const manifestPath = join(dirPath, '.cache-manifest.json');
      try {
        const manifestContent = await readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestContent) as CacheManifest;
        const size = await computeDirectorySize(dirPath);
        entries.push({
          key: manifest.key,
          paths: manifest.paths,
          createdAt: manifest.createdAt,
          size,
        });
      } catch {
        // Skip entries without valid manifests
      }
    }

    return entries;
  }

  /**
   * Clear all cached data.
   */
  async clear(): Promise<void> {
    try {
      await rm(this.baseDir, { recursive: true, force: true });
    } catch {
      // Already cleared or doesn't exist
    }
  }

  /**
   * Get the cache directory for a given key.
   * Uses a SHA-256 hash of the key for the directory name.
   */
  private getCacheDir(key: string): string {
    const hashedKey = createHash('sha256').update(key).digest('hex');
    return join(this.baseDir, hashedKey);
  }
}

// ─── Glob utilities ───────────────────────────────────────────────────────────

/** Check if a string looks like a glob pattern. */
function isGlobPattern(str: string): boolean {
  return str.includes('*') || str.includes('?');
}

/**
 * Convert a simple glob pattern to a RegExp.
 * Supports: `*` (any chars except separator), `**` (any chars including separator), `?` (single char).
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = '';
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    if (ch === '*') {
      if (i + 1 < len && pattern[i + 1] === '*') {
        // ** matches anything including path separators
        if (i + 2 < len && (pattern[i + 2] === '/' || pattern[i + 2] === '\\')) {
          regexStr += '(?:.+[\\/\\\\])?';
          i += 3;
        } else {
          regexStr += '.*';
          i += 2;
        }
      } else {
        // * matches anything except path separator
        regexStr += '[^\\/\\\\]*';
        i++;
      }
    } else if (ch === '?') {
      regexStr += '[^\\/\\\\]';
      i++;
    } else if (ch === '.') {
      regexStr += '\\.';
      i++;
    } else if (ch === '/' || ch === '\\') {
      regexStr += '[\\/\\\\]';
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  return new RegExp('^' + regexStr + '$');
}

/**
 * Recursively find files matching a glob pattern within a directory.
 */
async function findMatchingFiles(pattern: string, baseDir: string): Promise<string[]> {
  const regex = globToRegex(pattern);
  const results: string[] = [];

  async function walk(dir: string, relativePath: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip hidden dirs and node_modules for performance
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const fullPath = join(dir, entry.name);
      const relPath = relativePath ? relativePath + '/' + entry.name : entry.name;

      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (regex.test(relPath)) {
        results.push(fullPath);
      }
    }
  }

  await walk(baseDir, '');
  return results;
}

/**
 * Recursively compute the total size of a directory.
 */
async function computeDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += await computeDirectorySize(fullPath);
    } else {
      const fileStat = await stat(fullPath);
      totalSize += fileStat.size;
    }
  }

  return totalSize;
}
