// Variable guard — enforce settable variable restrictions.

import type { SettableVariablesConfig } from '../types/variables.js';

export interface VariableCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface VariableOperationsResult {
  valid: boolean;
  violations: string[];
}

/**
 * Guard that enforces which variables steps are allowed to set,
 * based on a SettableVariablesConfig.
 */
export class VariableGuard {
  /**
   * Check if a single variable can be set given the restrictions.
   *
   * Rules:
   * - If restrictions is undefined → allowed
   * - If `none: true` → blocked
   * - If `allowed` list exists → only those names are permitted (case-insensitive)
   */
  canSet(
    variableName: string,
    restrictions: SettableVariablesConfig | undefined,
  ): VariableCheckResult {
    if (!restrictions) {
      return { allowed: true };
    }

    if (restrictions.none) {
      return {
        allowed: false,
        reason: `Variable '${variableName}' cannot be set: settable variables are disabled (none: true)`,
      };
    }

    if (restrictions.allowed) {
      const lowerName = variableName.toLowerCase();
      const isAllowed = restrictions.allowed.some(
        (name) => name.toLowerCase() === lowerName,
      );
      if (!isAllowed) {
        return {
          allowed: false,
          reason: `Variable '${variableName}' is not in the allowed list: [${restrictions.allowed.join(', ')}]`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Validate a batch of variable operations against restrictions.
   * Returns all violations found.
   */
  validateVariableOperations(
    operations: { name: string; action: 'set' | 'update' }[],
    restrictions: SettableVariablesConfig | undefined,
  ): VariableOperationsResult {
    const violations: string[] = [];

    for (const op of operations) {
      const check = this.canSet(op.name, restrictions);
      if (!check.allowed) {
        violations.push(check.reason!);
      }
    }

    return { valid: violations.length === 0, violations };
  }
}
