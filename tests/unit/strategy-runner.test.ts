import { describe, it, expect, beforeEach } from 'vitest';
import type { JobStrategy } from '../../src/types/pipeline.js';
import type { JobRunResult } from '../../src/runtime/job-runner.js';
import {
  StrategyRunner,
  type JobInstance,
} from '../../src/runtime/strategy-runner.js';

describe('StrategyRunner', () => {
  let runner: StrategyRunner;

  beforeEach(() => {
    runner = new StrategyRunner();
  });

  // ─── Matrix expansion ──────────────────────────────────────────────

  describe('expandMatrix', () => {
    it('expands a single config into one instance', () => {
      const matrix: Record<string, Record<string, string>> = {
        linux_debug: { os: 'linux', config: 'debug' },
      };

      const instances = runner.expandMatrix('Build', matrix);

      expect(instances).toHaveLength(1);
      expect(instances[0].name).toBe('Build_linux_debug');
      expect(instances[0].variables).toEqual({ os: 'linux', config: 'debug' });
    });

    it('expands multiple configs into correct instances', () => {
      const matrix: Record<string, Record<string, string>> = {
        linux_debug: { os: 'linux', config: 'debug' },
        windows_release: { os: 'windows', config: 'release' },
        macos_debug: { os: 'macos', config: 'debug' },
      };

      const instances = runner.expandMatrix('Build', matrix);

      expect(instances).toHaveLength(3);
      expect(instances.map((i) => i.name)).toEqual([
        'Build_linux_debug',
        'Build_windows_release',
        'Build_macos_debug',
      ]);
    });

    it('injects matrix variables into each job instance', () => {
      const matrix: Record<string, Record<string, string>> = {
        config_a: { arch: 'x64', toolchain: 'gcc' },
        config_b: { arch: 'arm64', toolchain: 'clang' },
      };

      const instances = runner.expandMatrix('Compile', matrix);

      expect(instances[0].variables).toEqual({ arch: 'x64', toolchain: 'gcc' });
      expect(instances[1].variables).toEqual({ arch: 'arm64', toolchain: 'clang' });
    });

    it('returns empty array for empty matrix', () => {
      const instances = runner.expandMatrix('Build', {});
      expect(instances).toHaveLength(0);
    });

    it('creates independent variable copies per instance', () => {
      const matrix: Record<string, Record<string, string>> = {
        a: { key: 'value_a' },
        b: { key: 'value_b' },
      };

      const instances = runner.expandMatrix('Job', matrix);

      // Mutating one instance's variables should not affect another
      instances[0].variables['key'] = 'mutated';
      expect(instances[1].variables['key']).toBe('value_b');
    });
  });

  // ─── Parallel expansion ────────────────────────────────────────────

  describe('expandStrategy (parallel)', () => {
    it('creates N instances with correct names for parallel strategy', () => {
      const strategy: JobStrategy = { parallel: 3 };
      const expansion = runner.expandStrategy('Test', strategy);

      expect(expansion.instances).toHaveLength(3);
      expect(expansion.instances.map((i) => i.name)).toEqual([
        'Test_1',
        'Test_2',
        'Test_3',
      ]);
    });

    it('sets System.JobPositionInPhase (1-based) for each parallel instance', () => {
      const strategy: JobStrategy = { parallel: 2 };
      const expansion = runner.expandStrategy('Job', strategy);

      expect(expansion.instances[0].variables['System.JobPositionInPhase']).toBe('1');
      expect(expansion.instances[1].variables['System.JobPositionInPhase']).toBe('2');
    });

    it('sets System.TotalJobsInPhase to the total count', () => {
      const strategy: JobStrategy = { parallel: 4 };
      const expansion = runner.expandStrategy('Job', strategy);

      for (const instance of expansion.instances) {
        expect(instance.variables['System.TotalJobsInPhase']).toBe('4');
      }
    });
  });

  // ─── expandStrategy dispatching ────────────────────────────────────

  describe('expandStrategy', () => {
    it('uses matrix when both matrix and parallel are absent', () => {
      const strategy: JobStrategy = {};
      const expansion = runner.expandStrategy('Solo', strategy);

      expect(expansion.instances).toHaveLength(1);
      expect(expansion.instances[0].name).toBe('Solo');
      expect(expansion.instances[0].variables).toEqual({});
    });

    it('prefers matrix over parallel when both are defined', () => {
      const strategy: JobStrategy = {
        matrix: { a: { x: '1' } },
        parallel: 5,
      };

      const expansion = runner.expandStrategy('Job', strategy);
      expect(expansion.instances).toHaveLength(1);
      expect(expansion.instances[0].name).toBe('Job_a');
    });

    it('returns empty instances when matrix is empty', () => {
      const strategy: JobStrategy = { matrix: {} };
      const expansion = runner.expandStrategy('Job', strategy);

      // Empty matrix with no parallel → single fallback
      expect(expansion.instances).toHaveLength(1);
      expect(expansion.instances[0].name).toBe('Job');
    });
  });

  // ─── Job naming conventions ────────────────────────────────────────

  describe('job naming', () => {
    it('follows {jobName}_{configName} convention for matrix', () => {
      const matrix = { release: { mode: 'release' } };
      const instances = runner.expandMatrix('Build', matrix);
      expect(instances[0].name).toBe('Build_release');
    });

    it('follows {jobName}_{N} convention for parallel', () => {
      const strategy: JobStrategy = { parallel: 2 };
      const expansion = runner.expandStrategy('Deploy', strategy);
      expect(expansion.instances[0].name).toBe('Deploy_1');
      expect(expansion.instances[1].name).toBe('Deploy_2');
    });
  });

  // ─── maxParallel throttling ────────────────────────────────────────

  describe('runInstances', () => {
    function makeResult(name: string): JobRunResult {
      return { name, status: 'succeeded', duration: 0, steps: [] };
    }

    it('runs all instances concurrently when maxParallel is undefined', async () => {
      const instances: JobInstance[] = [
        { name: 'A', variables: {} },
        { name: 'B', variables: {} },
        { name: 'C', variables: {} },
      ];

      const startTimes: number[] = [];
      const results = await runner.runInstances(
        instances,
        undefined,
        async (instance) => {
          startTimes.push(Date.now());
          await delay(50);
          return makeResult(instance.name);
        },
      );

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.name)).toEqual(['A', 'B', 'C']);
    });

    it('returns empty array for no instances', async () => {
      const results = await runner.runInstances([], 2, async () =>
        makeResult('x'),
      );
      expect(results).toHaveLength(0);
    });

    it('throttles concurrent execution with maxParallel', async () => {
      const instances: JobInstance[] = [
        { name: 'A', variables: {} },
        { name: 'B', variables: {} },
        { name: 'C', variables: {} },
        { name: 'D', variables: {} },
      ];

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const results = await runner.runInstances(
        instances,
        2,
        async (instance) => {
          currentConcurrent++;
          if (currentConcurrent > maxConcurrent) {
            maxConcurrent = currentConcurrent;
          }
          await delay(50);
          currentConcurrent--;
          return makeResult(instance.name);
        },
      );

      expect(results).toHaveLength(4);
      // maxConcurrent should not exceed 2
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('runs sequentially with maxParallel=1', async () => {
      const instances: JobInstance[] = [
        { name: 'A', variables: {} },
        { name: 'B', variables: {} },
      ];

      const executionOrder: string[] = [];
      const results = await runner.runInstances(
        instances,
        1,
        async (instance) => {
          executionOrder.push(`start_${instance.name}`);
          await delay(20);
          executionOrder.push(`end_${instance.name}`);
          return makeResult(instance.name);
        },
      );

      expect(results).toHaveLength(2);
      // With maxParallel=1, B should not start before A finishes
      expect(executionOrder).toEqual([
        'start_A',
        'end_A',
        'start_B',
        'end_B',
      ]);
    });

    it('preserves result order matching instance order', async () => {
      const instances: JobInstance[] = [
        { name: 'Slow', variables: {} },
        { name: 'Fast', variables: {} },
      ];

      const results = await runner.runInstances(
        instances,
        undefined,
        async (instance) => {
          // Slow job takes longer but should still be at index 0
          const ms = instance.name === 'Slow' ? 60 : 10;
          await delay(ms);
          return makeResult(instance.name);
        },
      );

      expect(results[0].name).toBe('Slow');
      expect(results[1].name).toBe('Fast');
    });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
