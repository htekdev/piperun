/**
 * Dependency graph for topological sorting and subgraph extraction.
 * Used by both stage-level and job-level orchestration to determine
 * execution order and parallel batches.
 */

export interface GraphNode {
  id: string;
  dependsOn: string[];
}

export class DependencyGraph {
  private readonly nodes: Map<string, GraphNode>;
  private readonly adjacency: Map<string, Set<string>>;

  constructor(nodes: GraphNode[]) {
    this.nodes = new Map();
    this.adjacency = new Map();

    for (const node of nodes) {
      this.nodes.set(node.id, node);
      this.adjacency.set(node.id, new Set(node.dependsOn));
    }
  }

  /**
   * Topological sort using Kahn's algorithm.
   * Returns array of arrays — each inner array is a parallel batch.
   * First batch has no dependencies, second depends only on first, etc.
   */
  getExecutionOrder(): string[][] {
    const validation = this.validate();
    if (!validation.valid) {
      throw new DependencyGraphError(
        `Invalid dependency graph: ${validation.errors.join('; ')}`,
      );
    }

    const inDegree = new Map<string, number>();
    const reverseAdj = new Map<string, Set<string>>();

    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
      reverseAdj.set(id, new Set());
    }

    for (const [id, deps] of this.adjacency) {
      inDegree.set(id, deps.size);
      for (const dep of deps) {
        reverseAdj.get(dep)!.add(id);
      }
    }

    const batches: string[][] = [];
    let remaining = new Set(this.nodes.keys());

    while (remaining.size > 0) {
      // Collect all nodes with in-degree 0
      const batch: string[] = [];
      for (const id of remaining) {
        if (inDegree.get(id) === 0) {
          batch.push(id);
        }
      }

      if (batch.length === 0) {
        // This shouldn't happen after validation, but guard against it
        throw new DependencyGraphError(
          'Cycle detected during topological sort (internal error)',
        );
      }

      // Sort batch for deterministic ordering
      batch.sort();
      batches.push(batch);

      // Remove batch nodes and update in-degrees
      for (const id of batch) {
        remaining.delete(id);
        for (const dependent of reverseAdj.get(id) ?? []) {
          inDegree.set(dependent, (inDegree.get(dependent) ?? 1) - 1);
        }
      }

      // Rebuild remaining set reference for clarity
      remaining = new Set(remaining);
    }

    return batches;
  }

  /**
   * Get all transitive dependencies for a given node.
   * Returns the set of all ancestor node IDs (not including the node itself).
   */
  getDependencies(nodeId: string): string[] {
    if (!this.nodes.has(nodeId)) {
      return [];
    }

    const visited = new Set<string>();
    const stack = [...(this.adjacency.get(nodeId) ?? [])];

    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);

      for (const dep of this.adjacency.get(current) ?? []) {
        if (!visited.has(dep)) {
          stack.push(dep);
        }
      }
    }

    return [...visited].sort();
  }

  /**
   * Get the minimal subgraph needed to run specific target nodes.
   * Includes all transitive dependencies of the targets plus the targets themselves.
   */
  getSubgraph(targetIds: string[]): string[] {
    const result = new Set<string>();

    for (const targetId of targetIds) {
      if (!this.nodes.has(targetId)) {
        throw new DependencyGraphError(
          `Target node '${targetId}' not found in graph. Available: ${[...this.nodes.keys()].join(', ')}`,
        );
      }

      result.add(targetId);
      for (const dep of this.getDependencies(targetId)) {
        result.add(dep);
      }
    }

    return [...result].sort();
  }

  /**
   * Validate the graph for cycles and missing dependencies.
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Check for missing dependencies
    for (const [id, deps] of this.adjacency) {
      for (const dep of deps) {
        if (!this.nodes.has(dep)) {
          errors.push(
            `Node '${id}' depends on '${dep}' which does not exist`,
          );
        }
      }
    }

    // Check for cycles using DFS with coloring
    if (errors.length === 0) {
      const cycleError = this.detectCycles();
      if (cycleError) {
        errors.push(cycleError);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private detectCycles(): string | null {
    const WHITE = 0; // unvisited
    const GRAY = 1;  // in current DFS path
    const BLACK = 2; // fully processed

    const color = new Map<string, number>();
    const parent = new Map<string, string | null>();

    for (const id of this.nodes.keys()) {
      color.set(id, WHITE);
    }

    for (const id of this.nodes.keys()) {
      if (color.get(id) === WHITE) {
        const cycle = this.dfsDetectCycle(id, color, parent);
        if (cycle) {
          return cycle;
        }
      }
    }

    return null;
  }

  private dfsDetectCycle(
    nodeId: string,
    color: Map<string, number>,
    parent: Map<string, string | null>,
  ): string | null {
    const GRAY = 1;
    const BLACK = 2;

    color.set(nodeId, GRAY);

    for (const dep of this.adjacency.get(nodeId) ?? []) {
      if (color.get(dep) === GRAY) {
        // Found a cycle — reconstruct path
        const cyclePath = this.reconstructCyclePath(dep, nodeId, parent);
        return `Circular dependency detected: ${cyclePath}`;
      }
      if (color.get(dep) !== BLACK) {
        parent.set(dep, nodeId);
        const cycle = this.dfsDetectCycle(dep, color, parent);
        if (cycle) return cycle;
      }
    }

    color.set(nodeId, BLACK);
    return null;
  }

  private reconstructCyclePath(
    cycleStart: string,
    cycleEnd: string,
    parent: Map<string, string | null>,
  ): string {
    const path: string[] = [cycleStart, cycleEnd];
    let current: string | null | undefined = parent.get(cycleEnd) ?? null;

    while (current && current !== cycleStart) {
      path.push(current);
      current = parent.get(current) ?? null;
    }

    path.reverse();
    path.push(cycleStart); // close the loop
    return path.join(' → ');
  }
}

/**
 * Normalize a dependsOn field (which can be string, string[], or undefined)
 * to a string array.
 */
export function normalizeDependsOn(
  dependsOn: string | string[] | undefined,
): string[] {
  if (dependsOn === undefined || dependsOn === null) return [];
  if (typeof dependsOn === 'string') return [dependsOn];
  return [...dependsOn];
}

export class DependencyGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyGraphError';
  }
}
