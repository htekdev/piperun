import { describe, it, expect, beforeEach } from 'vitest';
import {
  createFunctionRegistry,
  lookupFunction,
  resetCounters,
  isTruthy,
  createStatusFunctions,
} from '../../src/functions/index.js';
import type { FunctionRegistry, ExpressionResult, StatusContext } from '../../src/functions/index.js';

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────
let registry: FunctionRegistry;

beforeEach(() => {
  resetCounters();
  registry = createFunctionRegistry({
    currentJobStatus: 'Succeeded',
    dependencyResults: {
      build: 'Succeeded',
      test: 'Failed',
      lint: 'SucceededWithIssues',
    },
    isCanceled: false,
  });
});

function call(name: string, ...args: ExpressionResult[]): ExpressionResult {
  const fn = lookupFunction(registry, name);
  if (!fn) throw new Error(`Function "${name}" not found in registry`);
  return fn(...args);
}

// ──────────────────────────────────────────
// Logical functions
// ──────────────────────────────────────────
describe('logical functions', () => {
  describe('isTruthy', () => {
    it.each([
      [null, false],
      [false, false],
      [0, false],
      ['', false],
      ['false', false],
      ['False', false],
      ['FALSE', false],
      ['0', false],
      [true, true],
      [1, true],
      ['hello', true],
      ['True', true],
      ['true', true],
      [42, true],
      [-1, true],
      [[], true],
      [{}, true],
    ])('isTruthy(%j) → %j', (input, expected) => {
      expect(isTruthy(input as ExpressionResult)).toBe(expected);
    });
  });

  describe('and', () => {
    it('returns true when all args are truthy', () => {
      expect(call('and', true, 1, 'yes')).toBe(true);
    });

    it('returns false when any arg is falsy', () => {
      expect(call('and', true, '', 'yes')).toBe(false);
    });

    it('returns false with fewer than 2 args', () => {
      expect(call('and', true)).toBe(false);
    });

    it('short-circuits on first falsy value', () => {
      expect(call('and', false, true, true)).toBe(false);
    });
  });

  describe('or', () => {
    it('returns true when any arg is truthy', () => {
      expect(call('or', false, 0, 'yes')).toBe(true);
    });

    it('returns false when all args are falsy', () => {
      expect(call('or', false, 0, '', null)).toBe(false);
    });

    it('returns false with fewer than 2 args', () => {
      expect(call('or', true)).toBe(false);
    });

    it('short-circuits on first truthy value', () => {
      expect(call('or', 'hello', false)).toBe(true);
    });
  });

  describe('not', () => {
    it('returns true for falsy values', () => {
      expect(call('not', false)).toBe(true);
      expect(call('not', 0)).toBe(true);
      expect(call('not', '')).toBe(true);
      expect(call('not', null)).toBe(true);
      expect(call('not', 'false')).toBe(true);
    });

    it('returns false for truthy values', () => {
      expect(call('not', true)).toBe(false);
      expect(call('not', 1)).toBe(false);
      expect(call('not', 'hello')).toBe(false);
    });
  });

  describe('xor', () => {
    it('returns true when exactly one arg is truthy', () => {
      expect(call('xor', true, false)).toBe(true);
      expect(call('xor', false, true)).toBe(true);
    });

    it('returns false when both are truthy or both are falsy', () => {
      expect(call('xor', true, true)).toBe(false);
      expect(call('xor', false, false)).toBe(false);
    });
  });

  describe('iif', () => {
    it('returns trueValue when condition is truthy', () => {
      expect(call('iif', true, 'yes', 'no')).toBe('yes');
    });

    it('returns falseValue when condition is falsy', () => {
      expect(call('iif', false, 'yes', 'no')).toBe('no');
    });

    it('returns null for missing arguments', () => {
      expect(call('iif', true)).toBe(null);
    });

    it('handles string truthiness in condition', () => {
      expect(call('iif', 'False', 'yes', 'no')).toBe('no');
      expect(call('iif', 'True', 'yes', 'no')).toBe('yes');
    });
  });
});

// ──────────────────────────────────────────
// Comparison functions
// ──────────────────────────────────────────
describe('comparison functions', () => {
  describe('eq', () => {
    it('compares equal strings (case-insensitive)', () => {
      expect(call('eq', 'Hello', 'hello')).toBe(true);
    });

    it('compares equal numbers', () => {
      expect(call('eq', 42, 42)).toBe(true);
    });

    it('compares different values', () => {
      expect(call('eq', 'abc', 'def')).toBe(false);
    });

    it('null == null is true', () => {
      expect(call('eq', null, null)).toBe(true);
    });

    it('null vs non-null is false', () => {
      expect(call('eq', null, 'hello')).toBe(false);
      expect(call('eq', 0, null)).toBe(false);
    });

    it('coerces string to number when compared with number', () => {
      expect(call('eq', '42', 42)).toBe(true);
      expect(call('eq', 10, '10')).toBe(true);
    });

    it('handles boolean comparison', () => {
      expect(call('eq', true, true)).toBe(true);
      expect(call('eq', true, false)).toBe(false);
    });

    it('handles boolean vs number coercion', () => {
      expect(call('eq', true, 1)).toBe(true);
      expect(call('eq', false, 0)).toBe(true);
    });

    it('falls back to string comparison for non-numeric mixed types', () => {
      expect(call('eq', 'abc', 42)).toBe(false);
      expect(call('eq', 42, 'abc')).toBe(false);
    });

    it('handles array/object fallback to string', () => {
      expect(call('eq', [], '')).toBe(true);
      expect(call('eq', {}, '')).toBe(true);
    });

    it('handles equal strings of different casing', () => {
      expect(call('eq', 'ABC', 'abc')).toBe(true);
    });
  });

  describe('ne', () => {
    it('returns true for different values', () => {
      expect(call('ne', 'abc', 'def')).toBe(true);
    });

    it('returns false for equal values', () => {
      expect(call('ne', 'hello', 'HELLO')).toBe(false);
    });

    it('null vs null is false (they are equal)', () => {
      expect(call('ne', null, null)).toBe(false);
    });

    it('null vs value is true', () => {
      expect(call('ne', null, 'hello')).toBe(true);
    });

    it('handles numeric coercion', () => {
      expect(call('ne', '42', 42)).toBe(false);
      expect(call('ne', '99', 42)).toBe(true);
    });
  });

  describe('gt', () => {
    it('compares numbers', () => {
      expect(call('gt', 10, 5)).toBe(true);
      expect(call('gt', 5, 10)).toBe(false);
      expect(call('gt', 5, 5)).toBe(false);
    });

    it('compares strings ordinally (case-insensitive)', () => {
      expect(call('gt', 'b', 'a')).toBe(true);
      expect(call('gt', 'a', 'b')).toBe(false);
    });

    it('handles null (null < everything)', () => {
      expect(call('gt', 'a', null)).toBe(true);
      expect(call('gt', null, 'a')).toBe(false);
    });
  });

  describe('lt', () => {
    it('compares numbers', () => {
      expect(call('lt', 5, 10)).toBe(true);
      expect(call('lt', 10, 5)).toBe(false);
    });

    it('handles equal values', () => {
      expect(call('lt', 5, 5)).toBe(false);
    });

    it('handles null (null < everything)', () => {
      expect(call('lt', null, 'a')).toBe(true);
      expect(call('lt', 'a', null)).toBe(false);
      expect(call('lt', null, null)).toBe(false);
    });

    it('compares strings ordinally (case-insensitive)', () => {
      expect(call('lt', 'a', 'b')).toBe(true);
      expect(call('lt', 'b', 'a')).toBe(false);
    });

    it('handles boolean-to-number coercion', () => {
      expect(call('lt', false, true)).toBe(true);
      expect(call('lt', true, false)).toBe(false);
    });

    it('handles string numeric coercion', () => {
      expect(call('lt', '5', 10)).toBe(true);
      expect(call('lt', 10, '5')).toBe(false);
    });
  });

  describe('ge', () => {
    it('compares numbers', () => {
      expect(call('ge', 10, 5)).toBe(true);
      expect(call('ge', 5, 5)).toBe(true);
      expect(call('ge', 4, 5)).toBe(false);
    });

    it('handles null', () => {
      expect(call('ge', null, null)).toBe(true);
      expect(call('ge', 'a', null)).toBe(true);
      expect(call('ge', null, 'a')).toBe(false);
    });

    it('handles string comparison', () => {
      expect(call('ge', 'b', 'a')).toBe(true);
      expect(call('ge', 'a', 'a')).toBe(true);
    });
  });

  describe('le', () => {
    it('compares numbers', () => {
      expect(call('le', 5, 10)).toBe(true);
      expect(call('le', 5, 5)).toBe(true);
      expect(call('le', 6, 5)).toBe(false);
    });

    it('handles null', () => {
      expect(call('le', null, null)).toBe(true);
      expect(call('le', null, 'a')).toBe(true);
      expect(call('le', 'a', null)).toBe(false);
    });

    it('handles string comparison', () => {
      expect(call('le', 'a', 'b')).toBe(true);
      expect(call('le', 'a', 'a')).toBe(true);
    });
  });

  describe('in', () => {
    it('returns true when needle is found in haystack', () => {
      expect(call('in', 'b', 'a', 'b', 'c')).toBe(true);
    });

    it('returns false when needle is not found', () => {
      expect(call('in', 'd', 'a', 'b', 'c')).toBe(false);
    });

    it('uses eq semantics (case-insensitive)', () => {
      expect(call('in', 'HELLO', 'hello', 'world')).toBe(true);
    });

    it('returns false with less than 2 args', () => {
      expect(call('in', 'a')).toBe(false);
    });

    it('handles numeric coercion', () => {
      expect(call('in', '42', 41, 42, 43)).toBe(true);
    });
  });

  describe('notIn', () => {
    it('returns true when needle is not in haystack', () => {
      expect(call('notin', 'd', 'a', 'b', 'c')).toBe(true);
    });

    it('returns false when needle is found', () => {
      expect(call('notin', 'b', 'a', 'b', 'c')).toBe(false);
    });

    it('returns true with fewer than 2 args', () => {
      expect(call('notin', 'a')).toBe(true);
    });
  });
});

// ──────────────────────────────────────────
// String functions
// ──────────────────────────────────────────
describe('string functions', () => {
  describe('contains', () => {
    it('returns true when haystack contains needle (case-insensitive)', () => {
      expect(call('contains', 'Hello World', 'WORLD')).toBe(true);
    });

    it('returns false when haystack does not contain needle', () => {
      expect(call('contains', 'Hello World', 'xyz')).toBe(false);
    });

    it('handles non-string inputs', () => {
      expect(call('contains', 42, '4')).toBe(true);
    });

    it('handles null inputs', () => {
      expect(call('contains', null, '')).toBe(true);
    });

    it('handles boolean inputs', () => {
      expect(call('contains', true, 'ru')).toBe(true);
    });

    it('handles array inputs (coerced to empty string)', () => {
      expect(call('contains', [1, 2], '')).toBe(true);
    });

    it('handles object inputs (coerced to empty string)', () => {
      expect(call('contains', {} as unknown as ExpressionResult, '')).toBe(true);
    });
  });

  describe('startsWith', () => {
    it('returns true when string starts with prefix (case-insensitive)', () => {
      expect(call('startswith', 'Hello World', 'HELLO')).toBe(true);
    });

    it('returns false when string does not start with prefix', () => {
      expect(call('startswith', 'Hello World', 'World')).toBe(false);
    });

    it('handles non-string input (number)', () => {
      expect(call('startswith', 42, '4')).toBe(true);
    });

    it('handles null input', () => {
      expect(call('startswith', null, '')).toBe(true);
    });

    it('handles boolean input', () => {
      expect(call('startswith', true, 'Tr')).toBe(true);
    });
  });

  describe('endsWith', () => {
    it('returns true when string ends with suffix (case-insensitive)', () => {
      expect(call('endswith', 'Hello World', 'WORLD')).toBe(true);
    });

    it('returns false when string does not end with suffix', () => {
      expect(call('endswith', 'Hello World', 'Hello')).toBe(false);
    });

    it('handles non-string input (number)', () => {
      expect(call('endswith', 42, '2')).toBe(true);
    });

    it('handles null input', () => {
      expect(call('endswith', null, '')).toBe(true);
    });

    it('handles boolean input', () => {
      expect(call('endswith', false, 'se')).toBe(true);
    });
  });

  describe('format', () => {
    it('replaces positional placeholders', () => {
      expect(call('format', 'Hello {0}!', 'World')).toBe('Hello World!');
    });

    it('handles multiple placeholders', () => {
      expect(call('format', '{0} + {1} = {2}', 1, 2, 3)).toBe('1 + 2 = 3');
    });

    it('handles repeated placeholders', () => {
      expect(call('format', '{0}-{0}', 'abc')).toBe('abc-abc');
    });

    it('escapes double braces', () => {
      expect(call('format', '{{0}} is {0}', 'value')).toBe('{0} is value');
    });

    it('escapes double closing braces', () => {
      expect(call('format', '{0} }}end', 'start')).toBe('start }end');
    });

    it('preserves invalid placeholders with out-of-range index', () => {
      expect(call('format', '{0} {5}', 'only')).toBe('only {5}');
    });

    it('handles format specifier for dates', () => {
      // Use a fixed date — 2024-03-15T10:30:45Z
      const result = call('format', '{0:yyyyMMdd}', '2024-03-15T10:30:45Z');
      expect(result).toBe('20240315');
    });

    it('handles null arguments', () => {
      expect(call('format', 'val={0}', null)).toBe('val=');
    });

    it('handles boolean arguments', () => {
      expect(call('format', '{0}', true)).toBe('True');
    });

    it('handles no closing brace', () => {
      expect(call('format', 'broken {0', 'value')).toBe('broken {0');
    });

    it('handles non-numeric index', () => {
      expect(call('format', '{abc}', 'value')).toBe('{abc}');
    });

    it('handles negative index', () => {
      expect(call('format', '{-1}', 'value')).toBe('{-1}');
    });

    it('handles non-date format specifier', () => {
      const result = call('format', '{0:notadate}', 'not-a-date-string');
      expect(typeof result).toBe('string');
    });

    it('handles unescaped single closing brace', () => {
      expect(call('format', 'end}')).toBe('end}');
    });

    it('handles format with no args', () => {
      expect(call('format', 'plain text')).toBe('plain text');
    });

    it('handles null format template', () => {
      expect(call('format', null)).toBe('');
    });
  });

  describe('join', () => {
    it('joins array elements with separator', () => {
      expect(call('join', ', ', ['a', 'b', 'c'])).toBe('a, b, c');
    });

    it('converts elements to strings', () => {
      expect(call('join', '-', [1, 2, 3])).toBe('1-2-3');
    });

    it('converts complex objects to empty string', () => {
      expect(call('join', ',', ['a', { key: 'val' }, 'b'])).toBe('a,,b');
    });

    it('handles non-array input', () => {
      expect(call('join', ',', 'hello')).toBe('hello');
    });

    it('handles null elements', () => {
      expect(call('join', ',', ['a', null, 'b'])).toBe('a,,b');
    });

    it('handles undefined elements in array', () => {
      expect(call('join', ',', ['a', undefined as unknown as ExpressionResult, 'b'])).toBe('a,,b');
    });

    it('handles null collection', () => {
      expect(call('join', ',', null)).toBe('');
    });

    it('handles boolean elements in array', () => {
      expect(call('join', ',', [true, false])).toBe('True,False');
    });

    it('handles number elements in array', () => {
      expect(call('join', '-', [1, 2, 3])).toBe('1-2-3');
    });
  });

  describe('split', () => {
    it('splits a string by delimiter', () => {
      expect(call('split', 'a,b,c', ',')).toEqual(['a', 'b', 'c']);
    });

    it('returns array with original string for empty delimiter', () => {
      expect(call('split', 'abc', '')).toEqual(['abc']);
    });

    it('handles null input', () => {
      expect(call('split', null, ',')).toEqual(['']);
    });
  });

  describe('replace', () => {
    it('replaces all occurrences', () => {
      expect(call('replace', 'aabbcc', 'bb', 'XX')).toBe('aaXXcc');
    });

    it('replaces multiple occurrences', () => {
      expect(call('replace', 'abab', 'ab', 'X')).toBe('XX');
    });

    it('handles empty oldValue (returns original)', () => {
      expect(call('replace', 'hello', '', 'X')).toBe('hello');
    });

    it('handles no matches', () => {
      expect(call('replace', 'hello', 'xyz', 'abc')).toBe('hello');
    });
  });

  describe('upper', () => {
    it('converts to uppercase', () => {
      expect(call('upper', 'hello')).toBe('HELLO');
    });

    it('handles non-string input', () => {
      expect(call('upper', 42)).toBe('42');
    });

    it('handles null input', () => {
      expect(call('upper', null)).toBe('');
    });

    it('handles boolean input', () => {
      expect(call('upper', true)).toBe('TRUE');
    });
  });

  describe('lower', () => {
    it('converts to lowercase', () => {
      expect(call('lower', 'HELLO')).toBe('hello');
    });

    it('handles non-string input', () => {
      expect(call('lower', 42)).toBe('42');
    });

    it('handles null input', () => {
      expect(call('lower', null)).toBe('');
    });

    it('handles boolean input', () => {
      expect(call('lower', true)).toBe('true');
    });
  });

  describe('trim', () => {
    it('trims whitespace', () => {
      expect(call('trim', '  hello  ')).toBe('hello');
    });

    it('trims tabs and newlines', () => {
      expect(call('trim', '\t\nhello\r\n')).toBe('hello');
    });

    it('handles non-string input', () => {
      expect(call('trim', 42)).toBe('42');
    });

    it('handles null input', () => {
      expect(call('trim', null)).toBe('');
    });
  });
});

// ──────────────────────────────────────────
// Collection functions
// ──────────────────────────────────────────
describe('collection functions', () => {
  describe('containsValue', () => {
    it('finds value in array', () => {
      expect(call('containsvalue', ['a', 'b', 'c'], 'b')).toBe(true);
    });

    it('finds value in array (case-insensitive)', () => {
      expect(call('containsvalue', ['Hello', 'World'], 'hello')).toBe(true);
    });

    it('returns false when value not in array', () => {
      expect(call('containsvalue', ['a', 'b'], 'z')).toBe(false);
    });

    it('finds value in object properties', () => {
      expect(call('containsvalue', { x: 'hello', y: 'world' } as unknown as ExpressionResult, 'world')).toBe(true);
    });

    it('returns false for non-collection input', () => {
      expect(call('containsvalue', 'string', 's')).toBe(false);
    });

    it('returns false for null collection', () => {
      expect(call('containsvalue', null, 'a')).toBe(false);
    });
  });

  describe('length', () => {
    it('returns string length', () => {
      expect(call('length', 'hello')).toBe(5);
    });

    it('returns array length', () => {
      expect(call('length', [1, 2, 3])).toBe(3);
    });

    it('returns object property count', () => {
      expect(call('length', { a: 1, b: 2 } as unknown as ExpressionResult)).toBe(2);
    });

    it('returns 0 for null', () => {
      expect(call('length', null)).toBe(0);
    });

    it('returns string length for numbers', () => {
      expect(call('length', 42)).toBe(2);
    });

    it('returns 0 for empty string', () => {
      expect(call('length', '')).toBe(0);
    });

    it('returns 0 for empty array', () => {
      expect(call('length', [])).toBe(0);
    });
  });

  describe('convertToJson', () => {
    it('converts string to JSON', () => {
      expect(call('converttojson', 'hello')).toBe('"hello"');
    });

    it('converts number to JSON', () => {
      expect(call('converttojson', 42)).toBe('42');
    });

    it('converts array to JSON', () => {
      expect(call('converttojson', [1, 2, 3])).toBe('[1,2,3]');
    });

    it('converts object to JSON', () => {
      expect(call('converttojson', { a: 1 } as unknown as ExpressionResult)).toBe('{"a":1}');
    });

    it('converts null to JSON', () => {
      expect(call('converttojson', null)).toBe('null');
    });

    it('converts boolean to JSON', () => {
      expect(call('converttojson', true)).toBe('true');
    });
  });

  describe('counter', () => {
    it('returns seed on first call', () => {
      expect(call('counter', 'test', 10)).toBe(10);
    });

    it('increments on subsequent calls', () => {
      call('counter', 'inc', 0);
      expect(call('counter', 'inc')).toBe(1);
      expect(call('counter', 'inc')).toBe(2);
    });

    it('tracks separate prefixes independently', () => {
      expect(call('counter', 'alpha', 100)).toBe(100);
      expect(call('counter', 'beta', 200)).toBe(200);
      expect(call('counter', 'alpha')).toBe(101);
      expect(call('counter', 'beta')).toBe(201);
    });

    it('uses 0 as default seed', () => {
      expect(call('counter', 'default')).toBe(0);
      expect(call('counter', 'default')).toBe(1);
    });
  });

  describe('coalesce', () => {
    it('returns first non-null, non-empty value', () => {
      expect(call('coalesce', null, '', 'hello', 'world')).toBe('hello');
    });

    it('returns empty string if all are null/empty', () => {
      expect(call('coalesce', null, '', null)).toBe('');
    });

    it('returns first value if it is non-null', () => {
      expect(call('coalesce', 'first', 'second')).toBe('first');
    });

    it('skips 0 (number zero is not null/empty)', () => {
      expect(call('coalesce', null, 0, 'hello')).toBe(0);
    });

    it('returns false (boolean false is not null/empty)', () => {
      expect(call('coalesce', null, false, 'hello')).toBe(false);
    });

    it('returns empty string with no args', () => {
      expect(call('coalesce')).toBe('');
    });

    it('skips undefined values', () => {
      expect(call('coalesce', undefined as unknown as ExpressionResult, 'found')).toBe('found');
    });
  });

  describe('counter — edge cases', () => {
    it('handles non-numeric string seed (falls back to 0)', () => {
      expect(call('counter', 'nanseed', 'notanumber')).toBe(0);
    });

    it('handles null prefix', () => {
      expect(call('counter', null, 5)).toBe(5);
    });

    it('handles boolean input coerced to string', () => {
      expect(call('counter', true, 1)).toBe(1);
    });
  });

  describe('containsValue — additional edge cases', () => {
    it('handles numeric values in array', () => {
      expect(call('containsvalue', [1, 2, 3], 2)).toBe(true);
    });

    it('handles numeric coercion in array (string vs number)', () => {
      expect(call('containsvalue', ['42', 'hello'], 42)).toBe(true);
    });

    it('handles null values in array', () => {
      expect(call('containsvalue', [null, 'a'], null)).toBe(true);
    });

    it('finds value in object with numeric coercion', () => {
      expect(call('containsvalue', { a: 42 } as unknown as ExpressionResult, '42')).toBe(true);
    });

    it('returns false when value not found in object', () => {
      expect(call('containsvalue', { a: 'hello' } as unknown as ExpressionResult, 'notfound')).toBe(false);
    });

    it('handles undefined collection', () => {
      expect(call('containsvalue')).toBe(false);
    });
  });

  describe('length — additional edge cases', () => {
    it('returns string length for booleans', () => {
      expect(call('length', true)).toBe(4);  // "true".length
      expect(call('length', false)).toBe(5); // "false".length
    });

    it('handles undefined input', () => {
      expect(call('length')).toBe(0);
    });
  });
});

// ──────────────────────────────────────────
// Status functions
// ──────────────────────────────────────────
describe('status functions', () => {
  describe('succeeded', () => {
    it('returns false when any dependency failed (no args)', () => {
      // default context has build=Succeeded, test=Failed, lint=SucceededWithIssues
      expect(call('succeeded')).toBe(false);
    });

    it('returns true when checking a specific succeeded job', () => {
      expect(call('succeeded', 'build')).toBe(true);
    });

    it('returns true for SucceededWithIssues job', () => {
      expect(call('succeeded', 'lint')).toBe(true);
    });

    it('returns false for a specific failed job', () => {
      expect(call('succeeded', 'test')).toBe(false);
    });

    it('returns true when all named jobs succeeded', () => {
      expect(call('succeeded', 'build', 'lint')).toBe(true);
    });

    it('returns false when any named job failed', () => {
      expect(call('succeeded', 'build', 'test')).toBe(false);
    });

    it('returns false for unknown job name', () => {
      expect(call('succeeded', 'nonexistent')).toBe(false);
    });

    it('returns true with no deps and Succeeded status', () => {
      const reg = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const fn = lookupFunction(reg, 'succeeded')!;
      expect(fn()).toBe(true);
    });
  });

  describe('failed', () => {
    it('returns true when any dependency failed (no args)', () => {
      expect(call('failed')).toBe(true);
    });

    it('returns true for a specific failed job', () => {
      expect(call('failed', 'test')).toBe(true);
    });

    it('returns false for a specific succeeded job', () => {
      expect(call('failed', 'build')).toBe(false);
    });

    it('returns true when checking multiple jobs and one failed', () => {
      expect(call('failed', 'build', 'test')).toBe(true);
    });

    it('returns false for unknown job name', () => {
      expect(call('failed', 'nonexistent')).toBe(false);
    });

    it('returns false with no deps and Succeeded status', () => {
      const reg = createFunctionRegistry({
        currentJobStatus: 'Succeeded',
        dependencyResults: {},
        isCanceled: false,
      });
      const fn = lookupFunction(reg, 'failed')!;
      expect(fn()).toBe(false);
    });
  });

  describe('succeededOrFailed', () => {
    it('returns true with no args (always)', () => {
      expect(call('succeededorfailed')).toBe(true);
    });

    it('returns true for succeeded/failed jobs', () => {
      expect(call('succeededorfailed', 'build', 'test')).toBe(true);
    });

    it('returns true for SucceededWithIssues', () => {
      expect(call('succeededorfailed', 'lint')).toBe(true);
    });

    it('returns false for unknown job (not in results)', () => {
      expect(call('succeededorfailed', 'nonexistent')).toBe(false);
    });
  });

  describe('always', () => {
    it('always returns true', () => {
      expect(call('always')).toBe(true);
    });

    it('returns true even when canceled', () => {
      const reg = createFunctionRegistry({
        currentJobStatus: 'Canceled',
        dependencyResults: {},
        isCanceled: true,
      });
      expect(lookupFunction(reg, 'always')!()).toBe(true);
    });
  });

  describe('canceled', () => {
    it('returns false when not canceled', () => {
      expect(call('canceled')).toBe(false);
    });

    it('returns true when canceled', () => {
      const reg = createFunctionRegistry({
        currentJobStatus: 'Canceled',
        dependencyResults: {},
        isCanceled: true,
      });
      expect(lookupFunction(reg, 'canceled')!()).toBe(true);
    });
  });
});

// ──────────────────────────────────────────
// Registry
// ──────────────────────────────────────────
describe('function registry', () => {
  const expectedFunctions = [
    // logical
    'and', 'or', 'not', 'xor', 'iif',
    // comparison
    'eq', 'ne', 'gt', 'lt', 'ge', 'le', 'in', 'notin',
    // string
    'contains', 'startswith', 'endswith', 'format', 'join',
    'split', 'replace', 'upper', 'lower', 'trim',
    // collection
    'containsvalue', 'length', 'converttojson', 'counter', 'coalesce',
    // status
    'succeeded', 'failed', 'succeededorfailed', 'always', 'canceled',
  ];

  it('registers all expected functions', () => {
    for (const name of expectedFunctions) {
      expect(lookupFunction(registry, name)).toBeDefined();
    }
  });

  it('performs case-insensitive lookup', () => {
    expect(lookupFunction(registry, 'AND')).toBeDefined();
    expect(lookupFunction(registry, 'Contains')).toBeDefined();
    expect(lookupFunction(registry, 'EQ')).toBeDefined();
    expect(lookupFunction(registry, 'ConvertToJson')).toBeDefined();
    expect(lookupFunction(registry, 'SUCCEEDED')).toBeDefined();
  });

  it('returns undefined for unknown functions', () => {
    expect(lookupFunction(registry, 'nonexistent')).toBeUndefined();
  });

  it('creates registry without status context', () => {
    const reg = createFunctionRegistry();
    expect(lookupFunction(reg, 'and')).toBeDefined();
    expect(lookupFunction(reg, 'succeeded')).toBeUndefined();
  });

  it('creates separate status function instances per context', () => {
    const ctx1: StatusContext = {
      currentJobStatus: 'Succeeded',
      dependencyResults: {},
      isCanceled: false,
    };
    const ctx2: StatusContext = {
      currentJobStatus: 'Canceled',
      dependencyResults: {},
      isCanceled: true,
    };
    const fns1 = createStatusFunctions(ctx1);
    const fns2 = createStatusFunctions(ctx2);
    expect(fns1.canceled()).toBe(false);
    expect(fns2.canceled()).toBe(true);
  });
});
