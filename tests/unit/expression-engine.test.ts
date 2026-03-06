import { describe, it, expect, beforeEach } from 'vitest';
import {
  createExpressionEngine,
  ExpressionEvaluationError,
  type ExpressionEngine,
  type FunctionRegistry,
  type ExpressionFunction,
} from '../../src/compiler/expression-engine.js';
import type { ExpressionContext, ExpressionResult } from '../../src/types/expressions.js';
import { expandMacros, findMacroReferences } from '../../src/variables/macro-expander.js';

// ─── Test helpers ───────────────────────────────────────────────────────────

function createTestContext(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    variables: {},
    parameters: {},
    dependencies: {},
    pipeline: {},
    ...overrides,
  };
}

function createTestFunctions(): FunctionRegistry {
  const fns: FunctionRegistry = new Map<string, ExpressionFunction>();

  fns.set('eq', (a: ExpressionResult, b: ExpressionResult) => a === b);
  fns.set('ne', (a: ExpressionResult, b: ExpressionResult) => a !== b);
  fns.set('not', (a: ExpressionResult) => !a);
  fns.set('and', (...args: ExpressionResult[]) => args.every(Boolean));
  fns.set('or', (...args: ExpressionResult[]) => args.some(Boolean));
  fns.set('contains', (haystack: ExpressionResult, needle: ExpressionResult) => {
    if (typeof haystack === 'string' && typeof needle === 'string') {
      return haystack.toLowerCase().includes(needle.toLowerCase());
    }
    return false;
  });
  fns.set('startswith', (str: ExpressionResult, prefix: ExpressionResult) => {
    if (typeof str === 'string' && typeof prefix === 'string') {
      return str.toLowerCase().startsWith(prefix.toLowerCase());
    }
    return false;
  });
  fns.set('endswith', (str: ExpressionResult, suffix: ExpressionResult) => {
    if (typeof str === 'string' && typeof suffix === 'string') {
      return str.toLowerCase().endsWith(suffix.toLowerCase());
    }
    return false;
  });
  fns.set('format', (template: ExpressionResult, ...args: ExpressionResult[]) => {
    if (typeof template !== 'string') return '';
    return template.replace(/\{(\d+)\}/g, (_m, idx) => {
      const i = parseInt(idx, 10);
      return i < args.length ? String(args[i] ?? '') : `{${idx}}`;
    });
  });
  fns.set('lower', (s: ExpressionResult) =>
    typeof s === 'string' ? s.toLowerCase() : '',
  );
  fns.set('upper', (s: ExpressionResult) =>
    typeof s === 'string' ? s.toUpperCase() : '',
  );
  fns.set('coalesce', (...args: ExpressionResult[]) => {
    for (const arg of args) {
      if (arg !== null && arg !== '' && arg !== undefined) return arg;
    }
    return '';
  });
  fns.set('join', (arr: ExpressionResult, sep: ExpressionResult) => {
    if (Array.isArray(arr)) {
      return arr.join(typeof sep === 'string' ? sep : ',');
    }
    return '';
  });
  fns.set('always', () => true);
  fns.set('succeeded', () => true);
  fns.set('failed', () => false);
  fns.set('cancelled', () => false);

  return fns;
}

// ─── Compile-time expression evaluation ─────────────────────────────────────

describe('ExpressionEngine — evaluateCompileTime', () => {
  let engine: ExpressionEngine;

  beforeEach(() => {
    engine = createExpressionEngine(createTestFunctions());
  });

  it('returns string as-is when no expressions present', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('hello world', ctx)).toBe('hello world');
  });

  it('evaluates a single string literal expression', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime("${{ 'hello' }}", ctx)).toBe('hello');
  });

  it('evaluates a single boolean expression (returns typed boolean)', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ true }}', ctx)).toBe(true);
  });

  it('evaluates a single number expression (returns typed number)', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ 42 }}', ctx)).toBe(42);
  });

  it('evaluates null expression', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ null }}', ctx)).toBe(null);
  });

  it('evaluates empty expression as empty string', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{  }}', ctx)).toBe('');
  });

  it('evaluates variable reference', () => {
    const ctx = createTestContext({ variables: { env: 'production' } });
    expect(engine.evaluateCompileTime('${{ variables.env }}', ctx)).toBe('production');
  });

  it('evaluates parameter reference', () => {
    const ctx = createTestContext({ parameters: { deploy: true } });
    expect(engine.evaluateCompileTime('${{ parameters.deploy }}', ctx)).toBe(true);
  });

  it('evaluates pipeline reference', () => {
    const ctx = createTestContext({ pipeline: { workspace: '/home/runner' } });
    expect(engine.evaluateCompileTime('${{ pipeline.workspace }}', ctx)).toBe('/home/runner');
  });

  it('returns empty string for unknown variable', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ variables.unknown }}', ctx)).toBe('');
  });

  it('evaluates function call (eq)', () => {
    const ctx = createTestContext({ variables: { env: 'prod' } });
    expect(engine.evaluateCompileTime("${{ eq(variables.env, 'prod') }}", ctx)).toBe(true);
  });

  it('evaluates function call (ne)', () => {
    const ctx = createTestContext({ variables: { env: 'dev' } });
    expect(engine.evaluateCompileTime("${{ ne(variables.env, 'prod') }}", ctx)).toBe(true);
  });

  it('evaluates nested function calls', () => {
    const ctx = createTestContext({ variables: { env: 'PROD' } });
    expect(
      engine.evaluateCompileTime("${{ eq(lower(variables.env), 'prod') }}", ctx),
    ).toBe(true);
  });

  it('evaluates deeply nested function calls', () => {
    const ctx = createTestContext({ variables: { env: 'prod', deploy: 'true' } });
    expect(
      engine.evaluateCompileTime(
        "${{ and(eq(variables.env, 'prod'), ne(variables.deploy, 'false')) }}",
        ctx,
      ),
    ).toBe(true);
  });

  it('interpolates expressions in a larger string', () => {
    const ctx = createTestContext({
      variables: { name: 'World', version: '2.0' },
    });
    expect(
      engine.evaluateCompileTime(
        'Hello ${{ variables.name }}, version ${{ variables.version }}!',
        ctx,
      ),
    ).toBe('Hello World, version 2.0!');
  });

  it('coerces boolean to string in interpolation', () => {
    const ctx = createTestContext({ variables: { env: 'prod' } });
    expect(
      engine.evaluateCompileTime(
        "Debug: ${{ eq(variables.env, 'prod') }}",
        ctx,
      ),
    ).toBe('Debug: True');
  });

  it('coerces null to empty string in interpolation', () => {
    const ctx = createTestContext();
    expect(
      engine.evaluateCompileTime('Value: ${{ null }}', ctx),
    ).toBe('Value: ');
  });

  it('evaluates format function', () => {
    const ctx = createTestContext({ variables: { name: 'Alice' } });
    expect(
      engine.evaluateCompileTime(
        "${{ format('Hello {0}!', variables.name) }}",
        ctx,
      ),
    ).toBe('Hello Alice!');
  });

  it('evaluates coalesce function', () => {
    const ctx = createTestContext({ variables: { fallback: 'default' } });
    expect(
      engine.evaluateCompileTime(
        "${{ coalesce(variables.missing, variables.fallback) }}",
        ctx,
      ),
    ).toBe('default');
  });

  it('throws on unknown function', () => {
    const ctx = createTestContext();
    expect(() =>
      engine.evaluateCompileTime("${{ nonExistentFn('x') }}", ctx),
    ).toThrow(ExpressionEvaluationError);
  });

  it('evaluates expression without whitespace in delimiters', () => {
    const ctx = createTestContext({ variables: { x: '1' } });
    expect(engine.evaluateCompileTime('${{variables.x}}', ctx)).toBe('1');
  });
});

// ─── Runtime expression evaluation ──────────────────────────────────────────

describe('ExpressionEngine — evaluateRuntime', () => {
  let engine: ExpressionEngine;

  beforeEach(() => {
    engine = createExpressionEngine(createTestFunctions());
  });

  it('returns string as-is when no runtime expressions present', () => {
    const ctx = createTestContext();
    expect(engine.evaluateRuntime('hello world', ctx)).toBe('hello world');
  });

  it('evaluates a single runtime expression', () => {
    const ctx = createTestContext({ variables: { status: 'success' } });
    expect(engine.evaluateRuntime('$[ variables.status ]', ctx)).toBe('success');
  });

  it('evaluates runtime boolean expression', () => {
    const ctx = createTestContext();
    expect(engine.evaluateRuntime('$[ succeeded() ]', ctx)).toBe(true);
  });

  it('evaluates runtime function call', () => {
    const ctx = createTestContext({ variables: { env: 'staging' } });
    expect(
      engine.evaluateRuntime("$[ eq(variables.env, 'staging') ]", ctx),
    ).toBe(true);
  });

  it('interpolates runtime expressions in a string', () => {
    const ctx = createTestContext({ variables: { name: 'Bob' } });
    expect(
      engine.evaluateRuntime('Name is $[ variables.name ]!', ctx),
    ).toBe('Name is Bob!');
  });

  it('does NOT process compile-time expressions', () => {
    const ctx = createTestContext({ variables: { x: '10' } });
    // ${{ }} should not be processed by evaluateRuntime
    expect(engine.evaluateRuntime('${{ variables.x }}', ctx)).toBe('${{ variables.x }}');
  });

  it('evaluates empty runtime expression as empty string', () => {
    const ctx = createTestContext();
    expect(engine.evaluateRuntime('$[  ]', ctx)).toBe('');
  });
});

// ─── Dependency access ──────────────────────────────────────────────────────

describe('ExpressionEngine — dependency access', () => {
  let engine: ExpressionEngine;

  beforeEach(() => {
    engine = createExpressionEngine(createTestFunctions());
  });

  it('accesses dependency result', () => {
    const ctx = createTestContext({
      dependencies: {
        buildJob: { result: 'Succeeded', outputs: {} },
      },
    });
    expect(
      engine.evaluateCompileTime('${{ dependencies.buildJob.result }}', ctx),
    ).toBe('Succeeded');
  });

  it('accesses dependency output via bracket notation', () => {
    const ctx = createTestContext({
      dependencies: {
        buildJob: {
          result: 'Succeeded',
          outputs: { 'step1.version': '2.1.0' },
        },
      },
    });
    expect(
      engine.evaluateCompileTime(
        "${{ dependencies.buildJob.outputs['step1.version'] }}",
        ctx,
      ),
    ).toBe('2.1.0');
  });

  it('returns empty string for unknown dependency', () => {
    const ctx = createTestContext({ dependencies: {} });
    expect(
      engine.evaluateCompileTime('${{ dependencies.missing.result }}', ctx),
    ).toBe('');
  });

  it('returns empty string for unknown dependency output', () => {
    const ctx = createTestContext({
      dependencies: {
        buildJob: { result: 'Succeeded', outputs: {} },
      },
    });
    expect(
      engine.evaluateCompileTime(
        "${{ dependencies.buildJob.outputs['nonexistent'] }}",
        ctx,
      ),
    ).toBe('');
  });
});

// ─── Process object tree ────────────────────────────────────────────────────

describe('ExpressionEngine — processObject', () => {
  let engine: ExpressionEngine;

  beforeEach(() => {
    engine = createExpressionEngine(createTestFunctions());
  });

  it('processes string values in an object', () => {
    const ctx = createTestContext({ variables: { env: 'prod' } });
    const result = engine.processObject(
      { name: '${{ variables.env }}', count: 5 },
      ctx,
      'compile',
    );
    expect(result).toEqual({ name: 'prod', count: 5 });
  });

  it('processes nested objects', () => {
    const ctx = createTestContext({ variables: { a: '1', b: '2' } });
    const result = engine.processObject(
      {
        outer: {
          inner: '${{ variables.a }}',
          other: '${{ variables.b }}',
        },
      },
      ctx,
      'compile',
    );
    expect(result).toEqual({ outer: { inner: '1', other: '2' } });
  });

  it('processes arrays', () => {
    const ctx = createTestContext({ variables: { x: 'hello' } });
    const result = engine.processObject(
      ['${{ variables.x }}', 'static', '${{ 42 }}'],
      ctx,
      'compile',
    );
    expect(result).toEqual(['hello', 'static', 42]);
  });

  it('passes through non-string primitives', () => {
    const ctx = createTestContext();
    const result = engine.processObject(
      { num: 42, bool: true, nil: null },
      ctx,
      'compile',
    );
    expect(result).toEqual({ num: 42, bool: true, nil: null });
  });

  it('processes runtime expressions in runtime mode', () => {
    const ctx = createTestContext({ variables: { env: 'staging' } });
    const result = engine.processObject(
      { env: '$[ variables.env ]' },
      ctx,
      'runtime',
    );
    expect(result).toEqual({ env: 'staging' });
  });

  it('does NOT process compile-time expressions in runtime mode', () => {
    const ctx = createTestContext({ variables: { env: 'staging' } });
    const result = engine.processObject(
      { env: '${{ variables.env }}' },
      ctx,
      'runtime',
    );
    expect(result).toEqual({ env: '${{ variables.env }}' });
  });
});

// ─── Macro expansion ────────────────────────────────────────────────────────

describe('expandMacros', () => {
  it('expands known variables', () => {
    expect(expandMacros('$(env)', { env: 'prod' })).toBe('prod');
  });

  it('expands multiple macros', () => {
    expect(
      expandMacros('$(greeting) $(name)!', { greeting: 'Hello', name: 'World' }),
    ).toBe('Hello World!');
  });

  it('leaves unknown variables as-is', () => {
    expect(expandMacros('$(unknown)', {})).toBe('$(unknown)');
  });

  it('handles dotted variable names', () => {
    expect(
      expandMacros('$(Pipeline.Workspace)/src', { 'Pipeline.Workspace': '/home/runner' }),
    ).toBe('/home/runner/src');
  });

  it('handles mixed known and unknown', () => {
    expect(
      expandMacros('$(known) and $(unknown)', { known: 'yes' }),
    ).toBe('yes and $(unknown)');
  });

  it('does not perform nested expansion', () => {
    expect(
      expandMacros('$(outer)', { outer: '$(inner)', inner: 'value' }),
    ).toBe('$(inner)');
  });

  it('handles empty input', () => {
    expect(expandMacros('', {})).toBe('');
  });

  it('handles string with no macros', () => {
    expect(expandMacros('plain text', { x: '1' })).toBe('plain text');
  });

  it('expands same macro multiple times', () => {
    expect(
      expandMacros('$(x) and $(x)', { x: 'val' }),
    ).toBe('val and val');
  });
});

describe('findMacroReferences', () => {
  it('finds no references in plain text', () => {
    expect(findMacroReferences('hello world')).toEqual([]);
  });

  it('finds single reference', () => {
    expect(findMacroReferences('$(env)')).toEqual(['env']);
  });

  it('finds multiple references', () => {
    expect(findMacroReferences('$(a) and $(b)')).toEqual(['a', 'b']);
  });

  it('finds dotted references', () => {
    expect(findMacroReferences('$(Pipeline.Workspace)')).toEqual(['Pipeline.Workspace']);
  });

  it('finds duplicate references', () => {
    expect(findMacroReferences('$(x) $(x)')).toEqual(['x', 'x']);
  });
});

// ─── Engine macro expansion ─────────────────────────────────────────────────

describe('ExpressionEngine — expandMacros', () => {
  let engine: ExpressionEngine;

  beforeEach(() => {
    engine = createExpressionEngine(createTestFunctions());
  });

  it('delegates to macro expander', () => {
    expect(engine.expandMacros('$(name)', { name: 'world' })).toBe('world');
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

describe('ExpressionEngine — edge cases', () => {
  let engine: ExpressionEngine;

  beforeEach(() => {
    engine = createExpressionEngine(createTestFunctions());
  });

  it('handles version literal in expression', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ 1.2.3 }}', ctx)).toBe('1.2.3');
  });

  it('handles negative number in expression', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ -10 }}', ctx)).toBe(-10);
  });

  it('handles string with escaped quotes', () => {
    const ctx = createTestContext();
    expect(
      engine.evaluateCompileTime("${{ 'it''s fine' }}", ctx),
    ).toBe("it's fine");
  });

  it('handles contains function', () => {
    const ctx = createTestContext({ variables: { branch: 'refs/heads/main' } });
    expect(
      engine.evaluateCompileTime(
        "${{ contains(variables.branch, 'main') }}",
        ctx,
      ),
    ).toBe(true);
  });

  it('handles startsWith function', () => {
    const ctx = createTestContext({ variables: { branch: 'refs/heads/main' } });
    expect(
      engine.evaluateCompileTime(
        "${{ startsWith(variables.branch, 'refs/heads') }}",
        ctx,
      ),
    ).toBe(true);
  });

  it('handles not function', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ not(false) }}', ctx)).toBe(true);
  });

  it('handles or function', () => {
    const ctx = createTestContext();
    expect(
      engine.evaluateCompileTime('${{ or(false, true) }}', ctx),
    ).toBe(true);
  });

  it('handles and function', () => {
    const ctx = createTestContext();
    expect(
      engine.evaluateCompileTime('${{ and(true, true) }}', ctx),
    ).toBe(true);
  });

  it('handles always function', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ always() }}', ctx)).toBe(true);
  });

  it('deeply nested property access returns empty for missing', () => {
    const ctx = createTestContext({ dependencies: {} });
    expect(
      engine.evaluateCompileTime(
        "${{ dependencies.a.b.c.d['e'] }}",
        ctx,
      ),
    ).toBe('');
  });

  it('handles array index access', () => {
    const ctx = createTestContext({
      parameters: { items: ['a', 'b', 'c'] },
    });
    expect(
      engine.evaluateCompileTime('${{ parameters.items[1] }}', ctx),
    ).toBe('b');
  });

  it('handles object parameter access', () => {
    const ctx = createTestContext({
      parameters: { config: { key: 'value' } },
    });
    expect(
      engine.evaluateCompileTime("${{ parameters.config['key'] }}", ctx),
    ).toBe('value');
  });

  it('handles multiple compile-time expressions in one string', () => {
    const ctx = createTestContext({
      variables: { a: 'X', b: 'Y' },
    });
    expect(
      engine.evaluateCompileTime(
        '${{ variables.a }}-${{ variables.b }}-${{ variables.a }}',
        ctx,
      ),
    ).toBe('X-Y-X');
  });

  it('processes object with mixed expression types and plain values', () => {
    const ctx = createTestContext({
      variables: { env: 'prod' },
      parameters: { debug: false },
    });
    const result = engine.processObject(
      {
        environment: '${{ variables.env }}',
        debug: '${{ parameters.debug }}',
        static: 'no-expression',
        nested: {
          msg: 'env is ${{ variables.env }}',
        },
      },
      ctx,
      'compile',
    );
    expect(result).toEqual({
      environment: 'prod',
      debug: false,
      static: 'no-expression',
      nested: {
        msg: 'env is prod',
      },
    });
  });

  it('resolves stageDependencies namespace as alias for dependencies', () => {
    const ctx = createTestContext({
      dependencies: {
        buildJob: { result: 'Succeeded' },
      },
    });
    expect(
      engine.evaluateCompileTime('${{ stageDependencies.buildJob.result }}', ctx),
    ).toBe('Succeeded');
  });

  it('returns empty for unknown stageDependencies', () => {
    const ctx = createTestContext({ dependencies: {} });
    expect(
      engine.evaluateCompileTime('${{ stageDependencies.missing }}', ctx),
    ).toBe('');
  });

  it('resolves variable without namespace from parameters', () => {
    const ctx = createTestContext({ parameters: { env: 'prod' } });
    expect(engine.evaluateCompileTime('${{ env }}', ctx)).toBe('prod');
  });

  it('resolves variable without namespace from dependencies', () => {
    const ctx = createTestContext({
      dependencies: { buildJob: 'done' as unknown },
    } as Partial<ExpressionContext>);
    expect(engine.evaluateCompileTime('${{ buildJob }}', ctx)).toBe('done');
  });

  it('resolves variable without namespace from pipeline', () => {
    const ctx = createTestContext({ pipeline: { workspace: '/runner' } });
    expect(engine.evaluateCompileTime('${{ workspace }}', ctx)).toBe('/runner');
  });

  it('returns empty for variable without namespace not found anywhere', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime('${{ missingVar }}', ctx)).toBe('');
  });

  it('handles unknown namespace with valid context key (env namespace)', () => {
    // The 'env' namespace is a KNOWN_NAMESPACE but falls through to the default
    // case in resolveVariable, which looks it up as a top-level context key.
    const ctx = createTestContext();
    const extCtx = ctx as unknown as Record<string, unknown>;
    extCtx['env'] = { MY_VAR: 'env-value' };
    expect(
      engine.evaluateCompileTime('${{ env.MY_VAR }}', extCtx as unknown as ExpressionContext),
    ).toBe('env-value');
  });

  it('returns empty for unknown namespace key not in context', () => {
    const ctx = createTestContext();
    // 'runner' is in KNOWN_NAMESPACES but not in context
    expect(
      engine.evaluateCompileTime('${{ runner.os }}', ctx),
    ).toBe('');
  });

  it('returns empty for known namespace with non-object context value', () => {
    const ctx = createTestContext();
    const extCtx = ctx as unknown as Record<string, unknown>;
    extCtx['env'] = 'not-an-object';
    expect(
      engine.evaluateCompileTime('${{ env.MY_VAR }}', extCtx as unknown as ExpressionContext),
    ).toBe('');
  });

  it('returns empty for known namespace with null context value', () => {
    const ctx = createTestContext();
    const extCtx = ctx as unknown as Record<string, unknown>;
    extCtx['strategy'] = null;
    expect(
      engine.evaluateCompileTime('${{ strategy.name }}', extCtx as unknown as ExpressionContext),
    ).toBe('');
  });

  it('handles navigateProperty on null value', () => {
    const ctx = createTestContext({ parameters: { val: null } });
    expect(
      engine.evaluateCompileTime('${{ parameters.val.prop }}', ctx),
    ).toBe('');
  });

  it('handles navigateProperty on non-object (string)', () => {
    const ctx = createTestContext({ variables: { name: 'hello' } });
    expect(
      engine.evaluateCompileTime('${{ variables.name.length }}', ctx),
    ).toBe('');
  });

  it('handles navigateProperty with missing key', () => {
    const ctx = createTestContext({
      parameters: { config: { existing: 'yes' } },
    });
    expect(
      engine.evaluateCompileTime('${{ parameters.config.missing }}', ctx),
    ).toBe('');
  });

  it('handles navigateIndex on null', () => {
    const ctx = createTestContext({ parameters: { val: null } });
    expect(
      engine.evaluateCompileTime('${{ parameters.val[0] }}', ctx),
    ).toBe('');
  });

  it('handles navigateIndex on array with out-of-bounds index', () => {
    const ctx = createTestContext({ parameters: { items: ['a'] } });
    expect(
      engine.evaluateCompileTime('${{ parameters.items[99] }}', ctx),
    ).toBe('');
  });

  it('handles navigateIndex on array with non-numeric index', () => {
    const ctx = createTestContext({ parameters: { items: ['a', 'b'] } });
    expect(
      engine.evaluateCompileTime("${{ parameters.items['x'] }}", ctx),
    ).toBe('');
  });

  it('handles navigateIndex on object with string key', () => {
    const ctx = createTestContext({
      parameters: { config: { key: 'value' } },
    });
    expect(
      engine.evaluateCompileTime("${{ parameters.config['key'] }}", ctx),
    ).toBe('value');
  });

  it('handles navigateIndex on object with missing key', () => {
    const ctx = createTestContext({
      parameters: { config: { key: 'value' } },
    });
    expect(
      engine.evaluateCompileTime("${{ parameters.config['missing'] }}", ctx),
    ).toBe('');
  });

  it('handles navigateIndex on non-object (string)', () => {
    const ctx = createTestContext({ variables: { name: 'hello' } });
    expect(
      engine.evaluateCompileTime("${{ variables.name[0] }}", ctx),
    ).toBe('');
  });

  it('coerces number to string in interpolation context', () => {
    const ctx = createTestContext({ parameters: { count: 42 } });
    expect(
      engine.evaluateCompileTime('Count: ${{ parameters.count }}', ctx),
    ).toBe('Count: 42');
  });

  it('coerces array to JSON in interpolation context', () => {
    const ctx = createTestContext({ parameters: { items: ['a', 'b'] } });
    expect(
      engine.evaluateCompileTime('Items: ${{ parameters.items }}', ctx),
    ).toBe('Items: ["a","b"]');
  });

  it('coerces object to JSON in interpolation context', () => {
    const ctx = createTestContext({
      parameters: { config: { k: 'v' } },
    });
    expect(
      engine.evaluateCompileTime('Config: ${{ parameters.config }}', ctx),
    ).toBe('Config: {"k":"v"}');
  });

  it('evaluateCompileTime returns non-string input as-is', () => {
    const ctx = createTestContext();
    expect(engine.evaluateCompileTime(42 as unknown as string, ctx)).toBe(42);
  });

  it('evaluateRuntime returns non-string input as-is', () => {
    const ctx = createTestContext();
    expect(engine.evaluateRuntime(true as unknown as string, ctx)).toBe(true);
  });

  it('processObject with null passes through', () => {
    const ctx = createTestContext();
    expect(engine.processObject(null, ctx, 'compile')).toBe(null);
  });

  it('processObject with undefined passes through', () => {
    const ctx = createTestContext();
    expect(engine.processObject(undefined, ctx, 'compile')).toBe(undefined);
  });

  it('processObject with number passes through', () => {
    const ctx = createTestContext();
    expect(engine.processObject(42, ctx, 'compile')).toBe(42);
  });

  it('processObject with boolean passes through', () => {
    const ctx = createTestContext();
    expect(engine.processObject(true, ctx, 'compile')).toBe(true);
  });
});
