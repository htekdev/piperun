import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContainerJobRunner } from '../../src/runtime/container-job-runner.js';

// Mock child_process.execFile
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

describe('ContainerJobRunner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  describe('isDockerAvailable', () => {
    it('returns true when Docker is available', async () => {
      const runner = new ContainerJobRunner();
      vi.mocked(execFile).mockImplementation((_cmd, _args, callback) => {
        (callback as Function)(null, 'Docker version 24.0.0');
        return {} as ReturnType<typeof execFile>;
      });

      const result = await runner.isDockerAvailable();
      expect(result).toBe(true);
    });

    it('returns false when Docker is not available', async () => {
      const runner = new ContainerJobRunner();
      vi.mocked(execFile).mockImplementation((_cmd, _args, callback) => {
        (callback as Function)(new Error('docker not found'));
        return {} as ReturnType<typeof execFile>;
      });

      const result = await runner.isDockerAvailable();
      expect(result).toBe(false);
    });

    it('caches result after first check', async () => {
      const runner = new ContainerJobRunner();
      const mockExecFile = vi.fn();
      mockExecFile.mockImplementation((_cmd: string, _args: string[], callback: Function) => {
        callback(null, 'Docker version 24.0.0');
        return {};
      });
      vi.mocked(execFile).mockImplementation(mockExecFile);

      await runner.isDockerAvailable();
      const result2 = await runner.isDockerAvailable();
      expect(result2).toBe(true);
      // execFile should only be called once due to caching
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveContainerConfig', () => {
    it('resolves string shorthand to image-only config', () => {
      const runner = new ContainerJobRunner();
      const config = runner.resolveContainerConfig('node:18');

      expect(config.image).toBe('node:18');
      expect(config.options).toBeUndefined();
      expect(config.env).toBeUndefined();
      expect(config.ports).toBeUndefined();
      expect(config.volumes).toBeUndefined();
    });

    it('resolves full container reference object', () => {
      const runner = new ContainerJobRunner();
      const config = runner.resolveContainerConfig({
        image: 'node:18',
        options: '--cpus 2',
        env: { NODE_ENV: 'test' },
        ports: ['8080:80'],
        volumes: ['/data:/data'],
      });

      expect(config.image).toBe('node:18');
      expect(config.options).toBe('--cpus 2');
      expect(config.env).toEqual({ NODE_ENV: 'test' });
      expect(config.ports).toEqual(['8080:80']);
      expect(config.volumes).toEqual(['/data:/data']);
    });
  });

  describe('validateContainerJob', () => {
    it('returns null when Docker is available', async () => {
      const runner = new ContainerJobRunner();
      vi.mocked(execFile).mockImplementation((_cmd, _args, callback) => {
        (callback as Function)(null, 'Docker version 24.0.0');
        return {} as ReturnType<typeof execFile>;
      });

      const result = await runner.validateContainerJob('node:18');
      expect(result).toBeNull();
    });

    it('returns error message when Docker is not available', async () => {
      const runner = new ContainerJobRunner();
      vi.mocked(execFile).mockImplementation((_cmd, _args, callback) => {
        (callback as Function)(new Error('not found'));
        return {} as ReturnType<typeof execFile>;
      });

      const result = await runner.validateContainerJob('node:18');
      expect(result).not.toBeNull();
      expect(result).toContain('Docker is not configured');
      expect(result).toContain('node:18');
    });

    it('returns error with image name from object reference', async () => {
      const runner = new ContainerJobRunner();
      vi.mocked(execFile).mockImplementation((_cmd, _args, callback) => {
        (callback as Function)(new Error('not found'));
        return {} as ReturnType<typeof execFile>;
      });

      const result = await runner.validateContainerJob({
        image: 'custom-image:latest',
      });
      expect(result).toContain('custom-image:latest');
    });
  });
});
