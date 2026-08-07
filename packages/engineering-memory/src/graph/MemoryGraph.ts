/**
 * Memory Graph
 * ==================================================================
 * Connects engineering entities into a unified graph.
 */

import { generateGraphNodeId, generateGraphEdgeId } from '../utils/idGenerator';

/** Memory Graph */
export class MemoryGraphBuilder {
  private nodes: Map<string, any> = new Map();
  private edges: Map<string, any> = new Map();

  addNode(type: string, _id: string, label: string, metadata: any = {}): any {
    const node = {
      id: generateGraphNodeId(),
      type,
      label,
      metadata,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.nodes.set(node.id, node);
    return node;
  }

  addEdge(sourceId: string, targetId: string, type: string, weight: number = 1.0): any {
    const edge = {
      id: generateGraphEdgeId(),
      source: sourceId,
      target: targetId,
      type,
      weight,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    this.edges.set(edge.id, edge);
    return edge;
  }

  getGraph(projectId: string): any {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
      projectId,
      updatedAt: new Date().toISOString(),
    };
  }

  getNode(nodeId: string): any {
    return this.nodes.get(nodeId);
  }

  getNeighbors(nodeId: string): any[] {
    const neighbors: any[] = [];
    for (const edge of this.edges.values()) {
      if (edge.source === nodeId || edge.target === nodeId) {
        const otherId = edge.source === nodeId ? edge.target : edge.source;
        const node = this.nodes.get(otherId);
        if (node) neighbors.push({ node, edge });
      }
    }
    return neighbors;
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
  }
}

export const memoryGraph = new MemoryGraphBuilder();
