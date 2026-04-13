// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useRef, useEffect } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { type LoadedEntity } from '@/lib/arke-types';

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  entity: LoadedEntity;
}

interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  predicate: string;
  relationshipId: string;
}

export interface LayoutResult {
  nodes: Array<{ id: string; x: number; y: number; entity: LoadedEntity }>;
  edges: Array<{ source: string; target: string; predicate: string; relationshipId: string }>;
}

// Layout presets
interface LayoutPreset {
  nodeRadius: number;
  linkDistance: number;
  linkStrength: number;
  repulsionStrength: number;
  repulsionDistanceMax: number;
  centerStrength: number;
  spawnDistance: number;
}

// Default: spacious layout for neighborhood exploration (Graph mode)
const GRAPH_PRESET: LayoutPreset = {
  nodeRadius: 140,
  linkDistance: 300,
  linkStrength: 0.4,
  repulsionStrength: -600,
  repulsionDistanceMax: 500,
  centerStrength: 0.015,
  spawnDistance: 150,
};

// Map: connected nodes cluster together, but enough space for cards not to overlap
const MAP_PRESET: LayoutPreset = {
  nodeRadius: 140,
  linkDistance: 250,
  linkStrength: 0.5,
  repulsionStrength: -500,
  repulsionDistanceMax: 400,
  centerStrength: 0.02,
  spawnDistance: 120,
};

const ITERATIONS_FULL = 150;
const ITERATIONS_INCREMENTAL = 20;
const INCREMENTAL_THRESHOLD = 0.2;

/**
 * Force-directed layout that naturally expands outward.
 *
 * Key insight: By removing centering forces (forceCenter, forceX, forceY)
 * and using strong repulsion, the graph naturally expands as nodes are added.
 * New nodes push existing nodes outward, creating frontier expansion.
 */
export function useGraphLayout(
  entities: Map<string, LoadedEntity>,
  pinnedPositions?: Map<string, { x: number; y: number }>,
  initialPositions?: Map<string, { x: number; y: number }>,
  mode: 'graph' | 'map' = 'graph',
): LayoutResult {
  // Persist positions across renders so nodes don't jump
  // Initialize with saved positions on first mount (for page refresh)
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(
    initialPositions ?? new Map()
  );

  const result = useMemo(() => {
    const p = mode === 'map' ? MAP_PRESET : GRAPH_PRESET;
    const prevPositions = positionsRef.current;

    // Build nodes array
    const nodes: LayoutNode[] = [];
    const seenEntityIds = new Set<string>();

    for (const loadedEntity of entities.values()) {
      const entityId = loadedEntity.entity.id;

      // Skip duplicates
      if (seenEntityIds.has(entityId)) continue;
      seenEntityIds.add(entityId);

      // Check if pinned (user-dragged)
      const pinned = pinnedPositions?.get(entityId);
      if (pinned) {
        nodes.push({
          id: entityId,
          entity: loadedEntity,
          x: pinned.x,
          y: pinned.y,
          fx: pinned.x,
          fy: pinned.y,
        });
        continue;
      }

      // Use previous position if available (fixed to prevent D3 from moving it)
      const prev = prevPositions.get(entityId);
      if (prev) {
        nodes.push({
          id: entityId,
          entity: loadedEntity,
          x: prev.x,
          y: prev.y,
          fx: prev.x,
          fy: prev.y,
        });
        continue;
      }

      // New node - spawn near a connected peer with random offset
      const relationships = loadedEntity.relationships || [];
      let spawned = false;

      for (const rel of relationships) {
        const peerId = rel.source_id === entityId ? rel.target_id : rel.source_id;
        const peerPos = pinnedPositions?.get(peerId) || prevPositions.get(peerId);
        if (peerPos) {
          // Random angle, moderate distance - D3 repulsion will push it outward
          const angle = Math.random() * Math.PI * 2;
          const distance = p.spawnDistance + Math.random() * (p.spawnDistance * 0.67);
          nodes.push({
            id: entityId,
            entity: loadedEntity,
            x: peerPos.x + Math.cos(angle) * distance,
            y: peerPos.y + Math.sin(angle) * distance,
          });
          spawned = true;
          break;
        }
      }

      // No connected peer found - spawn at origin
      if (!spawned) {
        nodes.push({ id: entityId, entity: loadedEntity, x: 0, y: 0 });
      }
    }

    // Build links
    const links: LayoutLink[] = [];
    const linkSet = new Set<string>();

    entities.forEach((loadedEntity) => {
      const entityId = loadedEntity.entity.id;
      const relationships = loadedEntity.relationships || [];

      relationships.forEach((rel) => {
        const peerId = rel.source_id === entityId ? rel.target_id : rel.source_id;
        if (!seenEntityIds.has(peerId)) return;

        // Filter out collection relationships
        if (rel.predicate === 'collection') return;

        // Preserve direction: source_id -> target_id
        const source = rel.source_id === entityId ? entityId : peerId;
        const target = rel.source_id === entityId ? peerId : entityId;
        const linkKey = `${source}-${target}-${rel.predicate}`;
        if (!linkSet.has(linkKey)) {
          linkSet.add(linkKey);
          links.push({
            source,
            target,
            predicate: rel.predicate,
            relationshipId: rel.id,
          });
        }
      });
    });

    // Run force simulation with balanced forces:
    // - Limited-range repulsion for intra-cluster spreading
    // - Very weak centering to prevent infinite drift
    const simulation = forceSimulation(nodes)
      .force(
        'link',
        forceLink<LayoutNode, LayoutLink>(links)
          .id((d) => d.id)
          .distance(p.linkDistance)
          .strength(p.linkStrength)
      )
      .force(
        'charge',
        forceManyBody()
          .strength(p.repulsionStrength)
          .distanceMax(p.repulsionDistanceMax)
      )
      .force('collide', forceCollide<LayoutNode>(p.nodeRadius).strength(1))
      .force('x', forceX(0).strength(p.centerStrength))
      .force('y', forceY(0).strength(p.centerStrength))
      .stop();

    // Adaptive tick count: few ticks for incremental adds, full for bulk/initial
    const newNodeCount = nodes.filter(n => n.fx === undefined).length;
    const isIncremental = newNodeCount > 0 && nodes.length > 0 && newNodeCount / nodes.length < INCREMENTAL_THRESHOLD;
    const ticks = isIncremental ? ITERATIONS_INCREMENTAL : ITERATIONS_FULL;

    for (let i = 0; i < ticks; i++) {
      simulation.tick();
    }

    // Build result
    const layoutNodes = nodes.map((n) => ({
      id: n.id,
      x: n.x ?? 0,
      y: n.y ?? 0,
      entity: n.entity,
    }));

    const layoutEdges = links.map((link) => ({
      source: typeof link.source === 'string' ? link.source : (link.source as LayoutNode).id,
      target: typeof link.target === 'string' ? link.target : (link.target as LayoutNode).id,
      predicate: link.predicate,
      relationshipId: link.relationshipId,
    }));

    return { nodes: layoutNodes, edges: layoutEdges };
  }, [entities, pinnedPositions, mode]);

  // Persist computed positions for next render — done as a side effect outside
  // useMemo so React 19 StrictMode's double-invocation doesn't cause position drift.
  useEffect(() => {
    for (const n of result.nodes) {
      positionsRef.current.set(n.id, { x: n.x, y: n.y });
    }
  }, [result]);

  return result;
}
