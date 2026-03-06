// Condition evaluator — evaluates stage/job/step conditions using the expression engine.

import type { ExpressionEngine } from '../compiler/expression-engine.js';
import type { FunctionRegistry } from '../functions/index.js';
import type { ExpressionContext, ExpressionResult } from '../types/expressions.js';
import { isTruthy } from '../functions/logical.js';

const DEFAULT_CONDITION = 'succeeded()';

export class ConditionEvaluator {
  constructor(
    private readonly expressionEngine: ExpressionEngine,
    private readonly _functionRegistry: FunctionRegistry,
  ) {}

  /**
   * Evaluate a condition string. Returns true if the step/job/stage should run.
   *
   * Rules:
   * - undefined → use defaultCondition (defaults to `succeeded()`)
   * - empty string → always run (true)
   * - expression string → evaluate and coerce to boolean via ADO truthiness
   */
  evaluate(
    condition: string | undefined,
    context: ExpressionContext,
    defaultCondition?: string,
  ): boolean {
    const effectiveCondition = this.resolveCondition(condition, defaultCondition);

    // Empty string means "always run"
    if (effectiveCondition === '') {
      return true;
    }

    // Wrap condition in runtime expression syntax $[ ] for evaluation
    const expressionInput = `$[${effectiveCondition}]`;
    const result: ExpressionResult = this.expressionEngine.evaluateRuntime(
      expressionInput,
      context,
    );

    return isTruthy(result);
  }

  /** Get the default condition for a step/job/stage. */
  getDefaultCondition(): string {
    return DEFAULT_CONDITION;
  }

  /** Resolve the effective condition to evaluate. */
  private resolveCondition(
    condition: string | undefined,
    defaultCondition?: string,
  ): string {
    if (condition !== undefined) {
      return condition;
    }
    return defaultCondition ?? DEFAULT_CONDITION;
  }
}
