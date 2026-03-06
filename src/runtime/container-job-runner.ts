/**
 * Container job runner — stub for Docker-based container job execution.
 * Checks for Docker availability and logs a warning if not configured.
 * Actual Docker integration can be expanded in a future phase.
 */

import { execFile } from 'node:child_process';
import type { ContainerReference } from '../types/pipeline.js';

export interface ContainerJobConfig {
  image: string;
  options?: string;
  env?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
}

export class ContainerJobRunner {
  private dockerAvailable: boolean | null = null;

  /**
   * Check whether Docker is available on this machine.
   * Caches the result after the first check.
   */
  async isDockerAvailable(): Promise<boolean> {
    if (this.dockerAvailable !== null) {
      return this.dockerAvailable;
    }

    this.dockerAvailable = await new Promise<boolean>((resolve) => {
      execFile('docker', ['version', '--format', '{{.Server.Version}}'], (error) => {
        if (error) {
          console.warn(
            '[ContainerJobRunner] Docker is not available on this system. ' +
              'Container jobs require Docker to be installed and running. ' +
              'Install Docker from https://docs.docker.com/get-docker/ to enable container job support.',
          );
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });

    return this.dockerAvailable;
  }

  /**
   * Resolve a container reference (string shorthand or full object) to a config.
   */
  resolveContainerConfig(
    container: string | ContainerReference,
  ): ContainerJobConfig {
    if (typeof container === 'string') {
      return { image: container };
    }
    return {
      image: container.image,
      options: container.options,
      env: container.env,
      ports: container.ports,
      volumes: container.volumes,
    };
  }

  /**
   * Validate that a container job can run.
   * Returns an error message if Docker is not configured, or null if ready.
   */
  async validateContainerJob(
    container: string | ContainerReference,
  ): Promise<string | null> {
    const available = await this.isDockerAvailable();
    if (!available) {
      const config = this.resolveContainerConfig(container);
      return (
        `Docker is not configured on this system. ` +
        `Cannot run container job with image "${config.image}". ` +
        `Please install Docker and ensure the Docker daemon is running.`
      );
    }
    return null;
  }
}
