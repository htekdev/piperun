import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { hostname, platform } from 'node:os';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import type {
  VariableDefinition,
  InlineVariable,
  VariableGroupReference,
  VariableTemplateReference,
  SimpleVariable,
  VariableScope,
  ResolvedVariable,
  SettableVariablesConfig,
} from '../types/variables.js';
import { SecretMasker } from './secret-masker.js';

/** Type guard: is the definition an InlineVariable? */
function isInlineVariable(v: VariableDefinition): v is InlineVariable {
  return 'name' in v && 'value' in v && typeof (v as InlineVariable).name === 'string';
}

/** Type guard: is the definition a VariableGroupReference? */
function isGroupReference(v: VariableDefinition): v is VariableGroupReference {
  return 'group' in v && typeof (v as VariableGroupReference).group === 'string';
}

/** Type guard: is the definition a VariableTemplateReference? */
function isTemplateReference(
  v: VariableDefinition,
): v is VariableTemplateReference {
  return 'template' in v && typeof (v as VariableTemplateReference).template === 'string';
}

interface ScopeEntry {
  level: VariableScope;
  name: string;
  variables: Map<string, ResolvedVariable>;
}

/**
 * Core variable manager with hierarchical scoped storage.
 *
 * Variables have a scope hierarchy: pipeline → stage → job.
 * Inner scopes see outer scope variables and can override them.
 * Variable names are case-insensitive for lookup.
 */
export class VariableManager {
  private readonly scopeStack: ScopeEntry[] = [];
  // lowercase key → canonical (original) name
  private readonly canonicalNames: Map<string, string> = new Map();
  private readonly secretMasker: SecretMasker;

  constructor(secretMasker?: SecretMasker) {
    this.secretMasker = secretMasker ?? new SecretMasker();
  }

  /** Get the associated secret masker. */
  getSecretMasker(): SecretMasker {
    return this.secretMasker;
  }

  /**
   * Create a new scope that inherits from parent.
   * This pushes a new scope onto the stack.
   * @deprecated Use enterScope() instead — createScope is kept for API compat.
   */
  createScope(level: VariableScope, _parentScope?: VariableScope): void {
    this.scopeStack.push({
      level,
      name: level,
      variables: new Map(),
    });
  }

  /** Enter a new scope level, pushing it onto the stack. */
  enterScope(level: VariableScope, name: string): void {
    this.scopeStack.push({
      level,
      name,
      variables: new Map(),
    });
  }

  /** Exit the current scope level, popping it from the stack. */
  exitScope(): void {
    if (this.scopeStack.length === 0) {
      throw new Error('Cannot exit scope: no scopes on the stack');
    }
    this.scopeStack.pop();
  }

  /** Get the current scope level, or undefined if no scopes exist. */
  get currentScope(): VariableScope | undefined {
    if (this.scopeStack.length === 0) {
      return undefined;
    }
    return this.scopeStack[this.scopeStack.length - 1].level;
  }

  /**
   * Create an isolated fork of this VariableManager.
   * The fork gets a deep copy of the current scope stack so concurrent
   * job instances (e.g., matrix fan-out) don't corrupt each other's scopes.
   */
  fork(): VariableManager {
    const forked = new VariableManager(this.secretMasker);
    for (const scope of this.scopeStack) {
      const clonedVars = new Map<string, ResolvedVariable>();
      for (const [key, resolved] of scope.variables) {
        clonedVars.set(key, { ...resolved });
      }
      forked.scopeStack.push({
        level: scope.level,
        name: scope.name,
        variables: clonedVars,
      });
    }
    for (const [key, value] of this.canonicalNames) {
      forked.canonicalNames.set(key, value);
    }
    return forked;
  }

  /**
   * Set a variable in the specified scope (defaults to current/innermost scope).
   * Throws if the variable is readonly and already set.
   */
  set(
    name: string,
    value: string,
    options?: {
      isSecret?: boolean;
      isOutput?: boolean;
      isReadOnly?: boolean;
      source?: ResolvedVariable['source'];
      scope?: VariableScope;
    },
  ): void {
    const targetScope = this.findOrCurrentScope(options?.scope);
    if (!targetScope) {
      throw new Error(
        'Cannot set variable: no scopes on the stack. Call enterScope() first.',
      );
    }

    const lowerName = name.toLowerCase();

    // Check readonly: search all scopes for an existing readonly variable
    const existing = this.findVariable(lowerName);
    if (existing && existing.isReadOnly) {
      throw new Error(
        `Variable '${existing.name}' is readonly and cannot be overwritten`,
      );
    }

    // Track canonical name
    this.canonicalNames.set(lowerName, name);

    const resolved: ResolvedVariable = {
      name,
      value,
      scope: targetScope.level,
      isSecret: options?.isSecret ?? false,
      isOutput: options?.isOutput ?? false,
      isReadOnly: options?.isReadOnly ?? false,
      source: options?.source ?? 'inline',
    };

    targetScope.variables.set(lowerName, resolved);

    // Register secret with masker
    if (resolved.isSecret && value !== '') {
      this.secretMasker.addSecret(value);
    }
  }

  /**
   * Get a variable value, searching from innermost to outermost scope.
   * Variable names are case-insensitive.
   */
  get(name: string): string | undefined {
    const resolved = this.getResolved(name);
    return resolved?.value;
  }

  /** Get a resolved variable with full metadata. */
  getResolved(name: string): ResolvedVariable | undefined {
    return this.findVariable(name.toLowerCase()) ?? undefined;
  }

  /** Get all variables visible at the current scope (innermost wins). */
  getAll(): Map<string, ResolvedVariable> {
    const merged = new Map<string, ResolvedVariable>();
    // Walk bottom-up (outermost first), so inner scopes overwrite
    for (const scope of this.scopeStack) {
      for (const [key, resolved] of scope.variables) {
        merged.set(key, resolved);
      }
    }
    return merged;
  }

  /** Check if a variable is a secret. */
  isSecret(name: string): boolean {
    const resolved = this.findVariable(name.toLowerCase());
    return resolved?.isSecret ?? false;
  }

  /**
   * Load variables from a pipeline definition's variable block.
   * Supports both `VariableDefinition[]` and `Record<string, string>` shorthand.
   */
  loadVariables(
    variables: VariableDefinition[] | Record<string, string>,
    scope: VariableScope,
  ): void {
    // If it's a plain Record<string, string>, treat as simple key-value map
    if (!Array.isArray(variables)) {
      for (const [key, value] of Object.entries(variables)) {
        this.set(key, value, { source: 'inline', scope });
      }
      return;
    }

    for (const varDef of variables) {
      if (isInlineVariable(varDef)) {
        this.set(varDef.name, varDef.value, {
          isReadOnly: varDef.readonly ?? false,
          source: 'inline',
          scope,
        });
      } else if (isGroupReference(varDef)) {
        // Group loading is async — skip here. Caller should use loadGroup() separately.
        // We store a marker so the caller knows groups need loading.
      } else if (isTemplateReference(varDef)) {
        // Template variables are resolved later by the template engine
      } else {
        // SimpleVariable: plain key-value object
        const simple = varDef as SimpleVariable;
        for (const [key, value] of Object.entries(simple)) {
          if (typeof value === 'string') {
            this.set(key, value, { source: 'inline', scope });
          }
        }
      }
    }
  }

  /**
   * Resolve runtime expressions ($[...]) in the current scope's variable values.
   * Used to expand $[dependencies...] and $[stageDependencies...] mappings
   * in job/stage variable sections.
   */
  resolveRuntimeExpressions(resolver: (value: string) => string): void {
    const topScope = this.scopeStack[this.scopeStack.length - 1];
    if (!topScope) return;

    for (const [, resolved] of topScope.variables) {
      if (typeof resolved.value === 'string' && resolved.value.includes('$[')) {
        const newValue = resolver(resolved.value);
        if (newValue !== resolved.value) {
          resolved.value =
            typeof newValue === 'string' ? newValue : String(newValue);
        }
      }
    }
  }

  /**
   * Load a variable group from a YAML file.
   * Search order: each searchPath + `/groupName.yaml`, then
   * `~/.piperun/config/groups/groupName.yaml`.
   */
  async loadGroup(groupName: string, searchPaths: string[]): Promise<void> {
    const candidates = [
      ...searchPaths.map((p) => join(p, `${groupName}.yaml`)),
      join(homedir(), '.piperun', 'config', 'groups', `${groupName}.yaml`),
    ];

    let content: string | null = null;
    let loadedPath: string | null = null;

    for (const candidate of candidates) {
      try {
        content = await readFile(candidate, 'utf-8');
        loadedPath = candidate;
        break;
      } catch {
        // File not found, try next
      }
    }

    if (content === null || loadedPath === null) {
      throw new Error(
        `Variable group '${groupName}' not found. Searched:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
      );
    }

    const parsed = yaml.load(content);
    if (parsed === null || parsed === undefined || typeof parsed !== 'object') {
      throw new Error(
        `Variable group '${groupName}' at ${loadedPath} is not a valid YAML object`,
      );
    }

    const groupData = parsed as Record<string, unknown>;
    const scope = this.currentScope ?? 'pipeline';

    for (const [key, rawValue] of Object.entries(groupData)) {
      if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
        this.set(key, String(rawValue), { source: 'group', scope });
      } else if (typeof rawValue === 'object' && rawValue !== null) {
        // Extended format: { value: 'xxx', isSecret: true }
        const extended = rawValue as Record<string, unknown>;
        const value = String(extended['value'] ?? '');
        const isSecret = extended['isSecret'] === true;
        this.set(key, value, { source: 'group', isSecret, scope });
      }
    }
  }

  /** Initialize system variables for a pipeline run. */
  initializeSystemVariables(context: {
    runId: string;
    runNumber: number;
    pipelineName: string;
    workspace: string;
    stageName?: string;
    jobName?: string;
    stepName?: string;
  }): void {
    const scope: VariableScope = 'pipeline';
    const opts = { source: 'system' as const, isReadOnly: true, scope };

    this.set('Pipeline.RunId', context.runId, opts);
    this.set('Pipeline.RunNumber', String(context.runNumber), opts);
    this.set('Pipeline.Name', context.pipelineName, opts);
    this.set('Pipeline.Workspace', context.workspace, opts);
    this.set('Stage.Name', context.stageName ?? '', opts);
    this.set('Stage.Attempt', '1', opts);
    this.set('Job.Name', context.jobName ?? '', opts);
    this.set('Job.Attempt', '1', opts);
    this.set('Step.Name', context.stepName ?? '', opts);
    this.set('Agent.OS', mapPlatformToAgentOS(), opts);
    this.set('Agent.MachineName', hostname(), opts);
    this.set('Agent.HomeDirectory', homedir(), opts);
    this.set('Agent.TempDirectory', tmpdir(), opts);
    this.set('Agent.WorkFolder', context.workspace, opts);
  }

  /** Get all variables as a flat Record for expression context. */
  toRecord(): Record<string, string> {
    const result: Record<string, string> = {};
    const all = this.getAll();
    for (const [, resolved] of all) {
      result[resolved.name] = resolved.value;
    }
    return result;
  }

  /**
   * Get all variables as environment variables (for passing to child processes).
   * Dots in names are replaced with underscores, names are uppercased.
   * Example: `Pipeline.RunId` → `PIPELINE_RUNID`
   */
  toEnvironment(): Record<string, string> {
    const result: Record<string, string> = {};
    const all = this.getAll();
    for (const [, resolved] of all) {
      const envKey = resolved.name.replace(/\./g, '_').toUpperCase();
      result[envKey] = resolved.value;
    }
    return result;
  }

  /**
   * Check settable variables restrictions.
   * If no restrictions configured, all variables are settable.
   * If `none: true`, no variables are settable.
   * If `allowed` list is set, only those names are settable (case-insensitive).
   */
  isSettable(name: string, restrictions?: SettableVariablesConfig): boolean {
    if (!restrictions) {
      return true;
    }
    if (restrictions.none) {
      return false;
    }
    if (restrictions.allowed) {
      const lowerName = name.toLowerCase();
      return restrictions.allowed.some(
        (allowed) => allowed.toLowerCase() === lowerName,
      );
    }
    return true;
  }

  // ---- Private helpers ----

  /**
   * Find a variable by lowercase name, searching from innermost to outermost scope.
   */
  private findVariable(lowerName: string): ResolvedVariable | null {
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const found = this.scopeStack[i].variables.get(lowerName);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Find a specific scope by level, or return the current (top-of-stack) scope.
   */
  private findOrCurrentScope(level?: VariableScope): ScopeEntry | null {
    if (this.scopeStack.length === 0) {
      return null;
    }
    if (!level) {
      return this.scopeStack[this.scopeStack.length - 1];
    }
    // Search from top to bottom to find the most recently created scope at this level
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.scopeStack[i].level === level) {
        return this.scopeStack[i];
      }
    }
    // If not found, use current scope
    return this.scopeStack[this.scopeStack.length - 1];
  }
}

/** Map Node.js platform() to an agent-style OS name. */
function mapPlatformToAgentOS(): string {
  const p = platform();
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
