import { describe, it, expect } from 'vitest';
import { ConditionEvaluator } from '../../src/runtime/condition-evaluator.js';
import { createExpressionEngine } from '../../src/compiler/expression-engine.js';
import { createFunctionRegistry } from '../../src/functions/index.js';
import type { StatusContext } from '../../src/functions/types.js';
import type { ExpressionContext } from '../../src/types/expressions.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createEvaluator(statusContext: StatusContext): ConditionEvaluator {
  const registry = createFunctionRegistry(statusContext);
  const engine = createExpressionEngine(registry);
  return new ConditionEvaluator(engine, registry);
}

function createContext(
  overrides?: Partial<ExpressionContext>,
): ExpressionContext {
  return {
    variables: {},
    parameters: {},
    dependencies: {},
    pipeline: {},
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ConditionEvaluator', () => {
  describe('getDefaultCondition', () => {
    it('returns succeeded() as the default condition', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      expect(evaluator.getDefaultCondition()).toBe('succeeded()');
    });
  });

  describe('undefined condition uses default', () => {
    it('uses succeeded() as default when condition is undefined', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const ctx = createContext();

      const result = evaluator.evaluate(undefined, ctx);

      expect(result).toBe(true);
    });

    it('uses custom default when provided', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Failed',
        dependencyResults: {},
        isCanceled: false,
      });
      const ctx = createContext();

      const result = evaluator.evaluate(undefined, ctx, 'failed()');

      expect(result).toBe(true);
    });
  });

  describe('succeeded()', () => {
    it('returns true when all dependencies succeeded', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {
          build: 'Succeeded',
          test: 'Succeeded',
        },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('succeeded()', ctx)).toBe(true);
    });

    it('returns true when dependency has succeededWithIssues', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {
          build: 'SucceededWithIssues',
        },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('succeeded()', ctx)).toBe(true);
    });

    it('returns false when any dependency failed', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {
          build: 'Succeeded',
          test: 'Failed',
        },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('succeeded()', ctx)).toBe(false);
    });

    it('returns true with no dependencies when job status is succeeded', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('succeeded()', ctx)).toBe(true);
    });
  });

  describe('failed()', () => {
    it('returns true when any dependency failed', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {
          build: 'Succeeded',
          test: 'Failed',
        },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('failed()', ctx)).toBe(true);
    });

    it('returns false when all dependencies succeeded', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {
          build: 'Succeeded',
          test: 'Succeeded',
        },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('failed()', ctx)).toBe(false);
    });

    it('returns true with no dependencies when job status is failed', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Failed',
        dependencyResults: {},
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('failed()', ctx)).toBe(true);
    });
  });

  describe('always()', () => {
    it('returns true when all succeeded', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: { build: 'Succeeded' },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('always()', ctx)).toBe(true);
    });

    it('returns true when dependencies failed', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Failed',
        dependencyResults: { build: 'Failed' },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('always()', ctx)).toBe(true);
    });

    it('returns true when canceled', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Canceled',
        dependencyResults: {},
        isCanceled: true,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('always()', ctx)).toBe(true);
    });
  });

  describe('canceled()', () => {
    it('returns true when pipeline is canceled', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Canceled',
        dependencyResults: {},
        isCanceled: true,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('canceled()', ctx)).toBe(true);
    });

    it('returns false when pipeline is not canceled', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('canceled()', ctx)).toBe(false);
    });
  });

  describe('custom expression conditions', () => {
    it('evaluates eq(variables.env, prod) to true when variable matches', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const ctx = createContext({
        variables: { env: 'prod' },
      });

      expect(evaluator.evaluate("eq(variables.env, 'prod')", ctx)).toBe(true);
    });

    it('evaluates eq(variables.env, prod) to false when variable differs', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const ctx = createContext({
        variables: { env: 'staging' },
      });

      expect(evaluator.evaluate("eq(variables.env, 'prod')", ctx)).toBe(false);
    });
  });

  describe('compound conditions', () => {
    it('evaluates and(succeeded(), ne(variables.skip, true)) correctly', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: { build: 'Succeeded' },
        isCanceled: false,
      });
      const ctx = createContext({
        variables: { skip: 'false' },
      });

      expect(
        evaluator.evaluate("and(succeeded(), ne(variables.skip, 'true'))", ctx),
      ).toBe(true);
    });

    it('returns false for and(succeeded(), ...) when dependency failed', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: { build: 'Failed' },
        isCanceled: false,
      });
      const ctx = createContext({
        variables: { skip: 'false' },
      });

      expect(
        evaluator.evaluate("and(succeeded(), ne(variables.skip, 'true'))", ctx),
      ).toBe(false);
    });

    it('returns false for and(succeeded(), ...) when variable matches skip', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: { build: 'Succeeded' },
        isCanceled: false,
      });
      const ctx = createContext({
        variables: { skip: 'true' },
      });

      expect(
        evaluator.evaluate("and(succeeded(), ne(variables.skip, 'true'))", ctx),
      ).toBe(false);
    });
  });

  describe('empty string condition', () => {
    it('returns true for empty string condition (always run)', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Failed',
        dependencyResults: { build: 'Failed' },
        isCanceled: true,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('', ctx)).toBe(true);
    });
  });

  describe('or() condition', () => {
    it('evaluates or(failed(), canceled()) to true when failed', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: { build: 'Failed' },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('or(failed(), canceled())', ctx)).toBe(true);
    });

    it('evaluates or(failed(), canceled()) to true when canceled', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Canceled',
        dependencyResults: { build: 'Succeeded' },
        isCanceled: true,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('or(failed(), canceled())', ctx)).toBe(true);
    });

    it('evaluates or(failed(), canceled()) to false when succeeded and not canceled', () => {
      const evaluator = createEvaluator({
        currentJobStatus: 'Succeeded',
        dependencyResults: { build: 'Succeeded' },
        isCanceled: false,
      });
      const ctx = createContext();

      expect(evaluator.evaluate('or(failed(), canceled())', ctx)).toBe(false);
    });
  });
});
