import { describe, it, expect } from 'vitest';
import {
  DependencyGraph,
  normalizeDependsOn,
  DependencyGraphError,
  type GraphNode,
} from '../../src/runtime/dependency-graph.js';

// ─── normalizeDependsOn ─────────────────────────────────────────────────────

describe('normalizeDependsOn', () => {
  it('returns empty array for undefined', () => {
    expect(normalizeDependsOn(undefined)).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(normalizeDependsOn(null as unknown as undefined)).toEqual([]);
  });

  it('wraps a string in an array', () => {
    expect(normalizeDependsOn('A')).toEqual(['A']);
  });

  it('returns a copy of an array', () => {
    const input = ['A', 'B'];
    const result = normalizeDependsOn(input);
    expect(result).toEqual(['A', 'B']);
    expect(result).not.toBe(input);
  });
});

// ─── Topological Sort ───────────────────────────────────────────────────────

describe('DependencyGraph - getExecutionOrder', () => {
  it('returns a single node with no dependencies', () => {
    const graph = new DependencyGraph([{ id: 'A', dependsOn: [] }]);
    expect(graph.getExecutionOrder()).toEqual([['A']]);
  });

  it('sorts a linear chain correctly', () => {
    const nodes: GraphNode[] = [
      { id: 'C', dependsOn: ['B'] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'A', dependsOn: [] },
    ];
    const graph = new DependencyGraph(nodes);
    const order = graph.getExecutionOrder();

    expect(order).toEqual([['A'], ['B'], ['C']]);
  });

  it('puts independent nodes in the same batch', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: [] },
      { id: 'C', dependsOn: [] },
    ];
    const graph = new DependencyGraph(nodes);
    const order = graph.getExecutionOrder();

    expect(order).toEqual([['A', 'B', 'C']]);
  });

  it('handles a diamond dependency pattern', () => {
    // A → B, C → D
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: ['B', 'C'] },
    ];
    const graph = new DependencyGraph(nodes);
    const order = graph.getExecutionOrder();

    expect(order).toEqual([['A'], ['B', 'C'], ['D']]);
  });

  it('handles complex graph with multiple paths', () => {
    //   A ──→ B ──→ D
    //   │           │
    //   └──→ C ──→ E
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: ['B'] },
      { id: 'E', dependsOn: ['C', 'D'] },
    ];
    const graph = new DependencyGraph(nodes);
    const order = graph.getExecutionOrder();

    expect(order[0]).toEqual(['A']);
    expect(order[1]).toEqual(['B', 'C']);
    expect(order[2]).toEqual(['D']);
    expect(order[3]).toEqual(['E']);
  });

  it('handles two independent chains', () => {
    // A → B and C → D
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: [] },
      { id: 'D', dependsOn: ['C'] },
    ];
    const graph = new DependencyGraph(nodes);
    const order = graph.getExecutionOrder();

    expect(order[0]).toEqual(['A', 'C']);
    expect(order[1]).toEqual(['B', 'D']);
  });

  it('produces deterministic sort order within batches', () => {
    const nodes: GraphNode[] = [
      { id: 'Z', dependsOn: [] },
      { id: 'A', dependsOn: [] },
      { id: 'M', dependsOn: [] },
    ];
    const graph = new DependencyGraph(nodes);
    const order = graph.getExecutionOrder();

    // Alphabetically sorted within the batch
    expect(order[0]).toEqual(['A', 'M', 'Z']);
  });

  it('handles empty graph', () => {
    const graph = new DependencyGraph([]);
    expect(graph.getExecutionOrder()).toEqual([]);
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe('DependencyGraph - validate', () => {
  it('validates a correct graph with no errors', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
    ];
    const graph = new DependencyGraph(nodes);
    const result = graph.validate();

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('detects missing dependencies', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: ['X'] }, // X doesn't exist
    ];
    const graph = new DependencyGraph(nodes);
    const result = graph.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("'A'");
    expect(result.errors[0]).toContain("'X'");
  });

  it('detects a simple cycle (A → B → A)', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: ['B'] },
      { id: 'B', dependsOn: ['A'] },
    ];
    const graph = new DependencyGraph(nodes);
    const result = graph.validate();

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Circular dependency');
  });

  it('detects a self-referencing cycle', () => {
    const nodes: GraphNode[] = [{ id: 'A', dependsOn: ['A'] }];
    const graph = new DependencyGraph(nodes);
    const result = graph.validate();

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Circular dependency');
  });

  it('detects a cycle in a larger graph', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
      { id: 'D', dependsOn: ['C', 'E'] },
      { id: 'E', dependsOn: ['D'] }, // E → D → E cycle
    ];
    const graph = new DependencyGraph(nodes);
    const result = graph.validate();

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Circular dependency');
  });

  it('validates empty graph as valid', () => {
    const graph = new DependencyGraph([]);
    expect(graph.validate()).toEqual({ valid: true, errors: [] });
  });

  it('throws on getExecutionOrder with cycles', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: ['B'] },
      { id: 'B', dependsOn: ['A'] },
    ];
    const graph = new DependencyGraph(nodes);

    expect(() => graph.getExecutionOrder()).toThrow(DependencyGraphError);
  });

  it('throws on getExecutionOrder with missing dependencies', () => {
    const nodes: GraphNode[] = [{ id: 'A', dependsOn: ['X'] }];
    const graph = new DependencyGraph(nodes);

    expect(() => graph.getExecutionOrder()).toThrow(DependencyGraphError);
  });
});

// ─── getDependencies ────────────────────────────────────────────────────────

describe('DependencyGraph - getDependencies', () => {
  it('returns empty for a root node', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
    ];
    const graph = new DependencyGraph(nodes);

    expect(graph.getDependencies('A')).toEqual([]);
  });

  it('returns direct dependencies', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
    ];
    const graph = new DependencyGraph(nodes);

    expect(graph.getDependencies('B')).toEqual(['A']);
  });

  it('returns transitive dependencies', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ];
    const graph = new DependencyGraph(nodes);

    expect(graph.getDependencies('C')).toEqual(['A', 'B']);
  });

  it('returns all transitive dependencies for diamond pattern', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: ['B', 'C'] },
    ];
    const graph = new DependencyGraph(nodes);

    expect(graph.getDependencies('D')).toEqual(['A', 'B', 'C']);
  });

  it('returns empty array for unknown node', () => {
    const graph = new DependencyGraph([{ id: 'A', dependsOn: [] }]);
    expect(graph.getDependencies('UNKNOWN')).toEqual([]);
  });
});

// ─── getSubgraph ────────────────────────────────────────────────────────────

describe('DependencyGraph - getSubgraph', () => {
  it('returns just the root node for a root target', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ];
    const graph = new DependencyGraph(nodes);

    expect(graph.getSubgraph(['A'])).toEqual(['A']);
  });

  it('returns the target + all ancestors for a leaf target', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ];
    const graph = new DependencyGraph(nodes);

    expect(graph.getSubgraph(['C'])).toEqual(['A', 'B', 'C']);
  });

  it('returns ancestors but not siblings', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
    ];
    const graph = new DependencyGraph(nodes);

    // Getting subgraph for B should not include C
    expect(graph.getSubgraph(['B'])).toEqual(['A', 'B']);
  });

  it('merges subgraphs for multiple targets', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: [] },
    ];
    const graph = new DependencyGraph(nodes);

    expect(graph.getSubgraph(['B', 'C'])).toEqual(['A', 'B', 'C']);
  });

  it('throws for unknown target', () => {
    const graph = new DependencyGraph([{ id: 'A', dependsOn: [] }]);

    expect(() => graph.getSubgraph(['UNKNOWN'])).toThrow(
      DependencyGraphError,
    );
    expect(() => graph.getSubgraph(['UNKNOWN'])).toThrow(
      /not found in graph/,
    );
  });

  it('handles diamond subgraph correctly', () => {
    const nodes: GraphNode[] = [
      { id: 'A', dependsOn: [] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['A'] },
      { id: 'D', dependsOn: ['B', 'C'] },
      { id: 'E', dependsOn: ['D'] },
    ];
    const graph = new DependencyGraph(nodes);

    // Subgraph for D should include A, B, C, D — not E
    expect(graph.getSubgraph(['D'])).toEqual(['A', 'B', 'C', 'D']);
  });
});
