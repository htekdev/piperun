// Local credential management — loads service connections from YAML config files.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import type { ServiceConnection, ServiceConnectionsConfig } from '../types/resources.js';

/**
 * Manages local service connections loaded from YAML configuration files.
 *
 * Search order:
 * 1. `.pipeline/connections.yaml` (project-local, higher priority)
 * 2. `~/.piperun/config/connections.yaml` (global user config)
 *
 * Project-local connections override global ones with the same name.
 */
export class ServiceConnectionManager {
  /**
   * Load all connections from both local and global config files.
   * Local `.pipeline/connections.yaml` overrides global `~/.piperun/config/connections.yaml`.
   */
  async loadConnections(workingDir: string): Promise<Map<string, ServiceConnection>> {
    const connections = new Map<string, ServiceConnection>();

    // Load global first (lower priority)
    const globalPath = join(homedir(), '.piperun', 'config', 'connections.yaml');
    const globalConnections = await this.loadFromFile(globalPath);
    for (const conn of globalConnections) {
      connections.set(conn.name, conn);
    }

    // Load local second (higher priority — overwrites global)
    const localPath = join(workingDir, '.pipeline', 'connections.yaml');
    const localConnections = await this.loadFromFile(localPath);
    for (const conn of localConnections) {
      connections.set(conn.name, conn);
    }

    return connections;
  }

  /**
   * Get a specific connection by name.
   */
  async getConnection(name: string, workingDir: string): Promise<ServiceConnection | undefined> {
    const connections = await this.loadConnections(workingDir);
    return connections.get(name);
  }

  /**
   * Load and parse service connections from a single YAML file.
   * Returns an empty array if the file doesn't exist or is invalid.
   */
  private async loadFromFile(filePath: string): Promise<ServiceConnection[]> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch {
      return [];
    }

    if (!parsed || typeof parsed !== 'object') {
      return [];
    }

    const config = parsed as ServiceConnectionsConfig;
    if (!Array.isArray(config.connections)) {
      return [];
    }

    return config.connections.map((conn) => ({
      name: conn.name,
      type: conn.type,
      url: conn.url,
      credentials: this.resolveCredentials(conn.credentials ?? {}),
    }));
  }

  /**
   * Resolve `${ENV_VAR}` references in credential values.
   * If the env var is not set, the placeholder remains as-is.
   */
  private resolveCredentials(credentials: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    const envVarPattern = /\$\{(\w+)\}/g;

    for (const [key, value] of Object.entries(credentials)) {
      resolved[key] = value.replace(envVarPattern, (_match, envName: string) => {
        return process.env[envName] ?? `\${${envName}}`;
      });
    }

    return resolved;
  }
}
