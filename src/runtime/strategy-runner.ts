/**
 * Strategy runner — expands matrix/parallel strategies into concrete job instances
 * and executes them with maxParallel throttling.
 */

import type { JobStrategy, PipelineStatus } from '../types/pipeline.js';
import type { JobRunResult } from './job-runner.js';

// ─── Public types ───────────────────────────────────────────────────────────

export interface StrategyExpansion {
  instances: JobInstance[];
}

export interface JobInstance {
  name: string;
  variables: Record<string, string>;
}

// ─── StrategyRunner class ───────────────────────────────────────────────────

export class StrategyRunner {
  /**
   * Expand a job strategy into concrete job instances.
   * If no matrix or parallel is defined, returns a single instance
   * with the original name and no extra variables.
   */
  expandStrategy(jobName: string, strategy: JobStrategy): StrategyExpansion {
    if (strategy.matrix && Object.keys(strategy.matrix).length > 0) {
      return { instances: this.expandMatrix(jobName, strategy.matrix) };
    }

    if (strategy.parallel !== undefined && strategy.parallel > 0) {
      return { instances: this.expandParallel(jobName, strategy.parallel) };
    }

    // No matrix or parallel — single instance with original name
    return { instances: [{ name: jobName, variables: {} }] };
  }

  /**
   * Expand a matrix into job instances.
   * Each key in the matrix is a configuration name (e.g., "linux_debug").
   * Each value is a map of variable name → value.
   * Each configuration produces one job instance named `{jobName}_{configName}`.
   */
  expandMatrix(
    jobName: string,
    matrix: Record<string, Record<string, string>>,
  ): JobInstance[] {
    const instances: JobInstance[] = [];

    for (const [configName, variables] of Object.entries(matrix)) {
      instances.push({
        name: `${jobName}_${configName}`,
        variables: { ...variables },
      });
    }

    return instances;
  }

  /**
   * Run expanded instances with maxParallel throttling.
   * Uses a semaphore pattern to limit concurrent execution.
   * If maxParallel is undefined or 0, runs all instances concurrently.
   */
  async runInstances(
    instances: JobInstance[],
    maxParallel: number | undefined,
    runFn: (instance: JobInstance) => Promise<JobRunResult>,
  ): Promise<JobRunResult[]> {
    if (instances.length === 0) {
      return [];
    }

    const effectiveMax =
      maxParallel !== undefined && maxParallel > 0
        ? maxParallel
        : instances.length;

    if (effectiveMax >= instances.length) {
      // Run all concurrently
      return Promise.all(instances.map(runFn));
    }

    // Semaphore-based throttling
    const results: JobRunResult[] = new Array(instances.length);
    let nextIndex = 0;

    const runNext = async (): Promise<void> => {
      while (nextIndex < instances.length) {
        const currentIndex = nextIndex;
        nextIndex++;
        results[currentIndex] = await runFn(instances[currentIndex]);
      }
    };

    // Launch `effectiveMax` concurrent workers
    const workers: Promise<void>[] = [];
    for (let i = 0; i < effectiveMax; i++) {
      workers.push(runNext());
    }

    await Promise.all(workers);
    return results;
  }

  /**
   * Expand a parallel strategy into N identical job copies.
   * Each copy gets a System.JobPositionInPhase variable (1-based).
   * Names become `{jobName}_1`, `{jobName}_2`, etc.
   */
  private expandParallel(jobName: string, count: number): JobInstance[] {
    const instances: JobInstance[] = [];

    for (let i = 1; i <= count; i++) {
      instances.push({
        name: `${jobName}_${i}`,
        variables: {
          'System.JobPositionInPhase': String(i),
          'System.TotalJobsInPhase': String(count),
        },
      });
    }

    return instances;
  }
}
