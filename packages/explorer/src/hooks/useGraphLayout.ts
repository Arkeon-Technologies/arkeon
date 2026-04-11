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

// Layout constants - balanced for intra-cluster spreading without extreme inter-cluster separation
const NODE_RADIUS = 140; // Collision radius for node spacing
const LINK_DISTANCE = 300; // Distance between connected nodes
const REPULSION_STRENGTH = -600; // Moderate repulsion for local spreading
const REPULSION_DISTANCE_MAX = 500; // Limit repulsion range - prevents disconnected clusters from flying apart
const CENTER_STRENGTH = 0.015; // Very weak centering to keep clusters within bounds
const ITERATIONS = 150; // Iterations for settling

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
  initialPositions?: Map<string, { x: number; y: number }>
): LayoutResult {
  // Persist positions across renders so nodes don't jump
  // Initialize with saved positions on first mount (for page refresh)
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(
    initialPositions ?? new Map()
  );

  const result = useMemo(() => {
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
          const distance = 150 + Math.random() * 100;
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
          .distance(LINK_DISTANCE)
          .strength(0.4) // Moderate link strength to keep connected nodes together
      )
      .force(
        'charge',
        forceManyBody()
          .strength(REPULSION_STRENGTH)
          .distanceMax(REPULSION_DISTANCE_MAX) // Key: limit repulsion range to prevent cluster drift
      )
      .force('collide', forceCollide<LayoutNode>(NODE_RADIUS).strength(1))
      // Very weak centering - just enough to keep clusters from flying to infinity
      .force('x', forceX(0).strength(CENTER_STRENGTH))
      .force('y', forceY(0).strength(CENTER_STRENGTH))
      .stop();

    // Run iterations
    for (let i = 0; i < ITERATIONS; i++) {
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
  }, [entities, pinnedPositions]);

  // Persist computed positions for next render — done as a side effect outside
  // useMemo so React 19 StrictMode's double-invocation doesn't cause position drift.
  useEffect(() => {
    for (const n of result.nodes) {
      positionsRef.current.set(n.id, { x: n.x, y: n.y });
    }
  }, [result]);

  return result;
}
