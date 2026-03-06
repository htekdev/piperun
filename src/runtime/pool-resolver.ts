// Pool resolver — map pool definitions to execution targets.

import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type { PoolDefinition } from '../types/pipeline.js';

export interface ResolvedPool {
  type: 'local' | 'container';
  name: string;
  /** Docker image for container type */
  image?: string;
  demands: string[];
}

export interface DemandsResult {
  satisfied: boolean;
  missing: string[];
}

/** Map of vmImage names to Docker images. */
const VM_IMAGE_MAP: Record<string, string> = {
  'ubuntu-latest': 'ubuntu:latest',
  'ubuntu-22.04': 'ubuntu:22.04',
  'ubuntu-20.04': 'ubuntu:20.04',
  'windows-latest': 'mcr.microsoft.com/windows/servercore:ltsc2022',
  'windows-2022': 'mcr.microsoft.com/windows/servercore:ltsc2022',
  'macos-latest': 'macos:latest',
  'macos-14': 'macos:14',
};

/**
 * Resolve pool definitions to concrete execution targets (local or container).
 * Validates demands against locally available tools.
 */
export class PoolResolver {
  /** Resolve a pool definition to an execution target. */
  resolvePool(pool: PoolDefinition | undefined): ResolvedPool {
    if (!pool) {
      return { type: 'local', name: 'default', demands: [] };
    }

    const demands = this.normalizeDemands(pool.demands);

    // vmImage → container execution
    if (pool.vmImage) {
      const image = this.mapVmImage(pool.vmImage);
      return {
        type: 'container',
        name: pool.vmImage,
        image: image ?? pool.vmImage,
        demands,
      };
    }

    // Named pool → local execution
    return {
      type: 'local',
      name: pool.name ?? 'default',
      demands,
    };
  }

  /** Map a vmImage name to a Docker image. Returns undefined if not in the map. */
  mapVmImage(vmImage: string): string | undefined {
    return VM_IMAGE_MAP[vmImage];
  }

  /** Validate demands against locally available capabilities. */
  validateDemands(demands: string[]): DemandsResult {
    const missing: string[] = [];

    for (const demand of demands) {
      if (!this.isDemandSatisfied(demand)) {
        missing.push(demand);
      }
    }

    return { satisfied: missing.length === 0, missing };
  }

  /** Discover capabilities of the local machine. */
  async checkCapabilities(): Promise<Record<string, string>> {
    const caps: Record<string, string> = {};
    const os = platform();

    caps['Agent.OS'] = this.mapPlatformName(os);

    const tools = ['node', 'npm', 'git', 'docker', 'python', 'python3', 'dotnet', 'java', 'go', 'pwsh'];
    for (const tool of tools) {
      const version = this.getToolVersion(tool);
      if (version) {
        caps[tool] = version;
      }
    }

    return caps;
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private normalizeDemands(demands: string | string[] | undefined): string[] {
    if (!demands) return [];
    if (typeof demands === 'string') return [demands];
    return demands;
  }

  /** Check if a single demand is satisfied on the local machine. */
  private isDemandSatisfied(demand: string): boolean {
    // Parse expression demands: "Agent.OS -equals Linux"
    const equalsMatch = demand.match(/^(\S+)\s+-equals\s+(.+)$/i);
    if (equalsMatch) {
      const [, key, expectedValue] = equalsMatch;
      if (key === 'Agent.OS') {
        const actual = this.mapPlatformName(platform());
        return actual.toLowerCase() === expectedValue.toLowerCase();
      }
      // Unknown key — treat as unsatisfied
      return false;
    }

    // Simple tool demand: check if tool is on PATH
    return this.isToolAvailable(demand);
  }

  /** Check if a tool is available on PATH. */
  private isToolAvailable(tool: string): boolean {
    const cmd = platform() === 'win32' ? `where ${tool}` : `which ${tool}`;
    try {
      execSync(cmd, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /** Get the version of a tool, or null if not available. */
  private getToolVersion(tool: string): string | null {
    const cmd = platform() === 'win32' ? `where ${tool}` : `which ${tool}`;
    try {
      execSync(cmd, { stdio: 'pipe' });
      // Try to get version
      try {
        const version = execSync(`${tool} --version`, {
          stdio: 'pipe',
          timeout: 5000,
        })
          .toString()
          .trim()
          .split('\n')[0];
        return version;
      } catch {
        return 'available';
      }
    } catch {
      return null;
    }
  }

  private mapPlatformName(p: string): string {
    switch (p) {
      case 'win32':
        return 'Windows_NT';
      case 'darwin':
        return 'Darwin';
      case 'linux':
        return 'Linux';
      default:
        return p;
    }
  }
}
