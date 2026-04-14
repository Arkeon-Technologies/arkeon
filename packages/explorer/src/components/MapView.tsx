// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Graph from 'graphology'
import {
  SigmaContainer,
  useRegisterEvents,
  useSigma,
  useSetSettings,
} from '@react-sigma/core'
import '@react-sigma/core/lib/style.css'
import forceAtlas2 from 'graphology-layout-forceatlas2'

import { type ArkeInstanceClient } from '@/lib/arke-client'
import { type LoadedEntity, type GraphEdge, type ArkeSpace } from '@/lib/arke-types'
import { useMapData, type UseMapDataResult } from '@/hooks/useMapData'
import { getEntitySpaceColor } from '@/lib/space-colors'
import { EntityPanel } from './EntityPanel'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Prefix for synthetic space node IDs to avoid collision with entity IDs */
const SPACE_NODE_PREFIX = '__space__'
/** Edge weight for space membership edges (real edges default to 1.0) */
const SPACE_EDGE_WEIGHT = 0.05

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Position a new node near its neighbors, or at the periphery if isolated. */
function neighborPosition(
  graph: Graph,
  edges: GraphEdge[],
  nodeId: string,
  spaceIds: string[],
): { x: number; y: number } {
  const positions: { x: number; y: number }[] = []

  // Check real edges for neighbor positions
  for (const edge of edges) {
    const neighborId =
      edge.source_id === nodeId
        ? edge.target_id
        : edge.target_id === nodeId
          ? edge.source_id
          : null
    if (neighborId && graph.hasNode(neighborId)) {
      const a = graph.getNodeAttributes(neighborId)
      positions.push({ x: a.x, y: a.y })
    }
  }

  // If no real neighbors, check for a space node to spawn near
  if (positions.length === 0 && spaceIds.length > 0) {
    const spaceNodeId = SPACE_NODE_PREFIX + spaceIds[0]
    if (graph.hasNode(spaceNodeId)) {
      const a = graph.getNodeAttributes(spaceNodeId)
      positions.push({ x: a.x, y: a.y })
    }
  }

  if (positions.length > 0) {
    const avgX = positions.reduce((s, p) => s + p.x, 0) / positions.length
    const avgY = positions.reduce((s, p) => s + p.y, 0) / positions.length
    return {
      x: avgX + (Math.random() - 0.5) * 20,
      y: avgY + (Math.random() - 0.5) * 20,
    }
  }
  // No neighbors — place at periphery
  let cx = 0, cy = 0, count = 0
  graph.forEachNode((_, a) => { cx += a.x; cy += a.y; count++ })
  if (count > 0) { cx /= count; cy /= count }
  const angle = Math.random() * Math.PI * 2
  const radius = Math.sqrt(Math.max(count, 1)) * 30 + 50
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
}

/** Build a map of space_id → color from space-colors module */
function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0')
  return hex + a
}

// ---------------------------------------------------------------------------
// Inner component: sync data → graphology, run layout, handle events
// ---------------------------------------------------------------------------

interface GraphEventsProps {
  data: UseMapDataResult
  edges: GraphEdge[]
  spaces: ArkeSpace[]
  selectId?: string
  selectedId: string | null
  selectedRelEndpoints: { sourceId: string; targetId: string; edgeId: string } | null
  onSelect: (id: string) => void
  onDeselect: () => void
  onEntitySelect?: (entityId: string) => void
}

function GraphSyncAndEvents({
  data,
  edges,
  spaces,
  selectId,
  selectedId,
  selectedRelEndpoints,
  onSelect,
  onDeselect,
  onEntitySelect,
}: GraphEventsProps) {
  const sigma = useSigma()
  const registerEvents = useRegisterEvents()
  const setSettings = useSetSettings()
  const { nodes, loading } = data
  const layoutDoneRef = useRef(false)
  const hoveredNodeRef = useRef<string | null>(null)
  const hoveredEdgeRef = useRef<string | null>(null)

  // Build a lookup for spaces that actually have members in the graph
  const spaceMap = useMemo(() => {
    const map = new Map<string, ArkeSpace>()
    for (const s of spaces) map.set(s.id, s)
    return map
  }, [spaces])

  // ── Sync nodes + edges + space nodes into graphology, run layout ──
  useEffect(() => {
    const graph = sigma.getGraph()

    // On reset (loading with empty nodes), clear the graph
    if (loading && nodes.size === 0) {
      graph.clear()
      layoutDoneRef.current = false
      sigma.getCamera().setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1 })
      return
    }

    // Don't sync while still loading
    if (loading) return

    // Remove stale nodes (handles reset → reload)
    const stale: string[] = []
    graph.forEachNode((id) => {
      if (id.startsWith(SPACE_NODE_PREFIX)) return // space nodes managed below
      if (!nodes.has(id)) stale.push(id)
    })
    for (const id of stale) graph.dropNode(id)

    // Add new entity nodes
    let addedNodes = 0
    for (const [id, node] of nodes) {
      if (!graph.hasNode(id)) {
        const pos = layoutDoneRef.current
          ? neighborPosition(graph, edges, id, node.space_ids)
          : { x: Math.random() * 200 - 100, y: Math.random() * 200 - 100 }
        graph.addNode(id, {
          x: pos.x,
          y: pos.y,
          size: 2,
          color: getEntitySpaceColor(node.space_ids),
          label: node.label || node.type,
          type: 'circle',
        })
        addedNodes++
      }
    }

    // Add new real edges
    let addedEdges = 0
    for (const edge of edges) {
      if (!graph.hasNode(edge.source_id) || !graph.hasNode(edge.target_id)) continue
      if (graph.hasEdge(edge.id)) continue
      try {
        graph.addEdgeWithKey(edge.id, edge.source_id, edge.target_id, {
          color: '#4a4a4a',
          size: 1,
          weight: 1,
          predicate: edge.predicate,
          type: 'line',
        })
        addedEdges++
      } catch { /* duplicate edge key */ }
    }

    // ── Synthesize space nodes + membership edges ──
    // Collect which spaces have members in the current graph
    const activeSpaces = new Map<string, string[]>() // space_id → [entity_ids]
    for (const [id, node] of nodes) {
      for (const spaceId of node.space_ids) {
        let members = activeSpaces.get(spaceId)
        if (!members) { members = []; activeSpaces.set(spaceId, members) }
        members.push(id)
      }
    }

    // Add/update space nodes
    for (const [spaceId, memberIds] of activeSpaces) {
      const spaceNodeId = SPACE_NODE_PREFIX + spaceId
      const space = spaceMap.get(spaceId)
      const spaceColor = getEntitySpaceColor([spaceId])

      if (!graph.hasNode(spaceNodeId)) {
        // Position space node at centroid of its members (or random if first load)
        let sx = 0, sy = 0
        let count = 0
        for (const mid of memberIds) {
          if (graph.hasNode(mid)) {
            const a = graph.getNodeAttributes(mid)
            sx += a.x; sy += a.y; count++
          }
        }
        if (count > 0) { sx /= count; sy /= count }
        else { sx = Math.random() * 200 - 100; sy = Math.random() * 200 - 100 }

        graph.addNode(spaceNodeId, {
          x: sx,
          y: sy,
          size: 5,
          color: hexWithAlpha(spaceColor, 0.6),
          label: space?.name || spaceId.slice(0, 8),
          type: 'circle',
          isSpace: true,
        })
        addedNodes++
      }

      // Add membership edges (low weight, nearly invisible)
      for (const memberId of memberIds) {
        const edgeKey = `${SPACE_NODE_PREFIX}${spaceId}__${memberId}`
        if (graph.hasEdge(edgeKey)) continue
        if (!graph.hasNode(memberId)) continue
        try {
          graph.addEdgeWithKey(edgeKey, spaceNodeId, memberId, {
            color: 'transparent',
            size: 0,
            weight: SPACE_EDGE_WEIGHT,
            type: 'line',
            hidden: true,
            isSpaceEdge: true,
          })
          addedEdges++
        } catch { /* duplicate */ }
      }
    }

    // Remove space nodes that no longer have members
    const spaceNodesToRemove: string[] = []
    graph.forEachNode((id) => {
      if (!id.startsWith(SPACE_NODE_PREFIX)) return
      const spaceId = id.slice(SPACE_NODE_PREFIX.length)
      if (!activeSpaces.has(spaceId)) spaceNodesToRemove.push(id)
    })
    for (const id of spaceNodesToRemove) graph.dropNode(id)

    if (graph.order === 0) return
    if (addedNodes === 0 && addedEdges === 0 && layoutDoneRef.current) return

    if (!layoutDoneRef.current) {
      layoutDoneRef.current = true

      // ════════════════════════════════════════════════════════════════
      // Two-phase layout:
      //   Phase 1 — position spaces relative to each other
      //   Phase 2 — layout entities within each space independently
      // ════════════════════════════════════════════════════════════════

      // Build entity → space mapping
      const entityToSpace = new Map<string, string>()
      for (const [id, node] of nodes) {
        if (node.space_ids.length > 0) entityToSpace.set(id, node.space_ids[0])
      }

      // Count cross-space edges to weight the space graph
      const spaceEdgeWeights = new Map<string, number>() // "spaceA|spaceB" → count
      for (const edge of edges) {
        const sa = entityToSpace.get(edge.source_id)
        const sb = entityToSpace.get(edge.target_id)
        if (sa && sb && sa !== sb) {
          const key = [sa, sb].sort().join('|')
          spaceEdgeWeights.set(key, (spaceEdgeWeights.get(key) ?? 0) + 1)
        }
      }

      // Collect active space IDs
      const spaceIds = new Set<string>()
      for (const [, spaceId] of entityToSpace) spaceIds.add(spaceId)

      // ── Phase 1: Space-level layout ──
      const spacePositions = new Map<string, { x: number; y: number }>()

      if (spaceIds.size > 1) {
        const spaceGraph = new Graph()
        for (const sid of spaceIds) {
          spaceGraph.addNode(sid, {
            x: Math.random() * 100 - 50,
            y: Math.random() * 100 - 50,
          })
        }
        for (const [key, weight] of spaceEdgeWeights) {
          const [sa, sb] = key.split('|')
          if (spaceGraph.hasNode(sa) && spaceGraph.hasNode(sb)) {
            try {
              spaceGraph.addEdge(sa, sb, { weight })
            } catch { /* parallel edge */ }
          }
        }

        const spaceInferred = forceAtlas2.inferSettings(spaceGraph)
        forceAtlas2.assign(spaceGraph, {
          iterations: 200,
          settings: {
            ...spaceInferred,
            gravity: 0.1,
            scalingRatio: 100,
            strongGravityMode: false,
            edgeWeightInfluence: 1,
          },
        })

        // Store raw FA2 positions (will be scaled after we know cluster sizes)
        const rawSpacePositions = new Map<string, { x: number; y: number }>()
        spaceGraph.forEachNode((sid, attrs) => {
          rawSpacePositions.set(sid, { x: attrs.x, y: attrs.y })
        })

        // ── Phase 2a: Per-space entity layout (in local coordinates) ──
        // Run FA2 per space to determine internal layout + measure radii
        const spaceSubgraphs = new Map<string, Graph>()
        const spaceRadii = new Map<string, number>()

        for (const sid of spaceIds) {
          const memberIds: string[] = []
          for (const [eid, espace] of entityToSpace) {
            if (espace === sid) memberIds.push(eid)
          }
          if (memberIds.length === 0) continue

          const sub = new Graph()
          const memberSet = new Set(memberIds)
          for (const mid of memberIds) {
            sub.addNode(mid, { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 })
          }
          for (const edge of edges) {
            if (memberSet.has(edge.source_id) && memberSet.has(edge.target_id)) {
              if (!sub.hasEdge(edge.id)) {
                try { sub.addEdgeWithKey(edge.id, edge.source_id, edge.target_id, { weight: 1 }) }
                catch { /* skip */ }
              }
            }
          }

          if (sub.order > 1) {
            const subInferred = forceAtlas2.inferSettings(sub)
            const subIters = sub.order <= 50 ? 200 : sub.order <= 200 ? 150 : sub.order <= 1000 ? 80 : 40
            forceAtlas2.assign(sub, {
              iterations: subIters,
              settings: {
                ...subInferred,
                gravity: 0.01,
                scalingRatio: 20,
                strongGravityMode: false,
                barnesHutOptimize: sub.order > 500,
                edgeWeightInfluence: 1,
              },
            })
          }

          // Measure bounding radius from center
          let maxR = 0
          sub.forEachNode((_, attrs) => {
            const r = Math.sqrt(attrs.x * attrs.x + attrs.y * attrs.y)
            if (r > maxR) maxR = r
          })
          spaceRadii.set(sid, maxR || 50)
          spaceSubgraphs.set(sid, sub)
        }

        // ── Phase 2b: Scale space positions to prevent overlap ──
        // Find the minimum scale factor that keeps all space clusters separated
        const sids = Array.from(rawSpacePositions.keys())
        let bestScale = 1
        for (let i = 0; i < sids.length; i++) {
          for (let j = i + 1; j < sids.length; j++) {
            const pi = rawSpacePositions.get(sids[i])!
            const pj = rawSpacePositions.get(sids[j])!
            const rawDist = Math.sqrt((pi.x - pj.x) ** 2 + (pi.y - pj.y) ** 2) || 1
            const ri = spaceRadii.get(sids[i]) ?? 50
            const rj = spaceRadii.get(sids[j]) ?? 50
            const neededDist = (ri + rj) * 1.3 // 30% padding
            const neededScale = neededDist / rawDist
            if (neededScale > bestScale) bestScale = neededScale
          }
        }

        for (const [sid, raw] of rawSpacePositions) {
          spacePositions.set(sid, { x: raw.x * bestScale, y: raw.y * bestScale })
        }

        // Copy per-space layout positions to main graph
        for (const [sid, sub] of spaceSubgraphs) {
          const spacePos = spacePositions.get(sid) ?? { x: 0, y: 0 }
          sub.forEachNode((nid, attrs) => {
            if (graph.hasNode(nid)) {
              graph.setNodeAttribute(nid, 'x', spacePos.x + attrs.x)
              graph.setNodeAttribute(nid, 'y', spacePos.y + attrs.y)
            }
          })
          const spaceNodeId = SPACE_NODE_PREFIX + sid
          if (graph.hasNode(spaceNodeId)) {
            graph.setNodeAttribute(spaceNodeId, 'x', spacePos.x)
            graph.setNodeAttribute(spaceNodeId, 'y', spacePos.y)
          }
        }
      } else if (spaceIds.size === 1) {
        const sid = spaceIds.values().next().value!
        spacePositions.set(sid, { x: 0, y: 0 })

        // Still need to run per-space layout for the single space
        const memberIds: string[] = []
        for (const [eid, espace] of entityToSpace) {
          if (espace === sid) memberIds.push(eid)
        }
        if (memberIds.length > 1) {
          const sub = new Graph()
          const memberSet = new Set(memberIds)
          for (const mid of memberIds) {
            sub.addNode(mid, { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 })
          }
          for (const edge of edges) {
            if (memberSet.has(edge.source_id) && memberSet.has(edge.target_id)) {
              try { sub.addEdgeWithKey(edge.id, edge.source_id, edge.target_id, { weight: 1 }) }
              catch { /* skip */ }
            }
          }
          const subInferred = forceAtlas2.inferSettings(sub)
          forceAtlas2.assign(sub, {
            iterations: sub.order <= 200 ? 150 : 80,
            settings: { ...subInferred, gravity: 0.01, scalingRatio: 20, barnesHutOptimize: sub.order > 500, edgeWeightInfluence: 1 },
          })
          sub.forEachNode((nid, attrs) => {
            if (graph.hasNode(nid)) {
              graph.setNodeAttribute(nid, 'x', attrs.x)
              graph.setNodeAttribute(nid, 'y', attrs.y)
            }
          })
        }
        const spaceNodeId = SPACE_NODE_PREFIX + sid
        if (graph.hasNode(spaceNodeId)) {
          graph.setNodeAttribute(spaceNodeId, 'x', 0)
          graph.setNodeAttribute(spaceNodeId, 'y', 0)
        }
      }

      // ── Spaceless entities: find connected components among them ──
      const spacelessIds: string[] = []
      graph.forEachNode((id) => {
        if (id.startsWith(SPACE_NODE_PREFIX)) return
        if (!entityToSpace.has(id)) spacelessIds.push(id)
      })

      if (spacelessIds.length > 0) {
        // Layout spaceless nodes that have edges among themselves
        const slSet = new Set(spacelessIds)
        const slGraph = new Graph()
        for (const id of spacelessIds) {
          slGraph.addNode(id, { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 })
        }
        for (const edge of edges) {
          if (slSet.has(edge.source_id) && slSet.has(edge.target_id)) {
            try { slGraph.addEdgeWithKey(edge.id, edge.source_id, edge.target_id, { weight: 1 }) }
            catch { /* skip */ }
          }
        }
        if (slGraph.order > 1 && slGraph.size > 0) {
          const slInferred = forceAtlas2.inferSettings(slGraph)
          forceAtlas2.assign(slGraph, {
            iterations: 150,
            settings: { ...slInferred, gravity: 0.05, scalingRatio: 10, edgeWeightInfluence: 1 },
          })
        }

        // Find a position away from all space clusters
        let maxDist = 0
        for (const pos of spacePositions.values()) {
          const d = Math.sqrt(pos.x * pos.x + pos.y * pos.y)
          if (d > maxDist) maxDist = d
        }
        const slOffset = { x: 0, y: maxDist + 300 }

        slGraph.forEachNode((id, attrs) => {
          if (graph.hasNode(id)) {
            graph.setNodeAttribute(id, 'x', slOffset.x + attrs.x)
            graph.setNodeAttribute(id, 'y', slOffset.y + attrs.y)
          }
        })
      }

      // ── Nudge cross-space entities toward their connected space ──
      for (const edge of edges) {
        const sa = entityToSpace.get(edge.source_id)
        const sb = entityToSpace.get(edge.target_id)
        if (!sa || !sb || sa === sb) continue
        // Nudge source toward target's space
        const targetSpacePos = spacePositions.get(sb)
        const sourceSpacePos = spacePositions.get(sa)
        if (!targetSpacePos || !sourceSpacePos) continue
        if (graph.hasNode(edge.source_id)) {
          const attrs = graph.getNodeAttributes(edge.source_id)
          const dx = targetSpacePos.x - sourceSpacePos.x
          const dy = targetSpacePos.y - sourceSpacePos.y
          const len = Math.sqrt(dx * dx + dy * dy) || 1
          graph.setNodeAttribute(edge.source_id, 'x', attrs.x + (dx / len) * 15)
          graph.setNodeAttribute(edge.source_id, 'y', attrs.y + (dy / len) * 15)
        }
        if (graph.hasNode(edge.target_id)) {
          const attrs = graph.getNodeAttributes(edge.target_id)
          const dx = sourceSpacePos.x - targetSpacePos.x
          const dy = sourceSpacePos.y - targetSpacePos.y
          const len = Math.sqrt(dx * dx + dy * dy) || 1
          graph.setNodeAttribute(edge.target_id, 'x', attrs.x + (dx / len) * 15)
          graph.setNodeAttribute(edge.target_id, 'y', attrs.y + (dy / len) * 15)
        }
      }

    } else {
      // Incremental: position new nodes near neighbors, run light FA2
      // Fix all existing nodes, only let new ones settle
      const newNodes = new Set<string>()
      graph.forEachNode((id) => {
        if (!id.startsWith(SPACE_NODE_PREFIX) && !graph.getNodeAttribute(id, '_settled')) {
          newNodes.add(id)
        }
      })
      // Mark all nodes as settled going forward
      graph.forEachNode((id) => {
        graph.setNodeAttribute(id, '_settled', true)
      })

      if (newNodes.size > 0) {
        // Fix all settled nodes, let new ones move
        graph.forEachNode((id) => {
          if (!newNodes.has(id)) graph.setNodeAttribute(id, 'fixed', true)
        })
        const inferred = forceAtlas2.inferSettings(graph)
        forceAtlas2.assign(graph, {
          iterations: 30,
          settings: {
            ...inferred,
            gravity: 0.01,
            scalingRatio: 20,
            strongGravityMode: false,
            barnesHutOptimize: graph.order > 500,
            edgeWeightInfluence: 1,
          },
        })
        // Unfix everything
        graph.forEachNode((id) => {
          graph.removeNodeAttribute(id, 'fixed')
        })
      }
    }
  }, [nodes, edges, spaces, loading, sigma, spaceMap])

  // ── Zoom to selected entity after layout ──
  useEffect(() => {
    if (!selectId || !layoutDoneRef.current) return
    const graph = sigma.getGraph()
    if (!graph.hasNode(selectId)) return

    sigma.refresh()
    const handler = () => {
      sigma.off('afterRender', handler)
      const d = sigma.getNodeDisplayData(selectId)
      if (!d) return
      sigma.getCamera().animate({ x: d.x, y: d.y, ratio: 0.1 }, { duration: 600 })
    }
    sigma.on('afterRender', handler)
    onSelect(selectId)
    return () => { sigma.off('afterRender', handler) }
  }, [selectId, loading, sigma, onSelect])

  // ── Click and hover events ──
  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => {
        // Don't select space nodes — they're synthetic
        if (node.startsWith(SPACE_NODE_PREFIX)) return
        onSelect(node)
        onEntitySelect?.(node)
      },
      clickEdge: ({ edge }) => {
        // Don't select space membership edges
        if (edge.startsWith(SPACE_NODE_PREFIX)) return
        onSelect(edge)
        onEntitySelect?.(edge)
      },
      clickStage: () => onDeselect(),
      enterNode: ({ node }) => {
        hoveredNodeRef.current = node
        sigma.refresh()
        const c = sigma.getContainer()
        if (c) c.style.cursor = node.startsWith(SPACE_NODE_PREFIX) ? 'default' : 'pointer'
      },
      leaveNode: () => {
        hoveredNodeRef.current = null
        sigma.refresh()
        const c = sigma.getContainer()
        if (c) c.style.cursor = 'default'
      },
      enterEdge: ({ edge }) => {
        if (edge.startsWith(SPACE_NODE_PREFIX)) return
        hoveredEdgeRef.current = edge
        sigma.refresh()
        const c = sigma.getContainer()
        if (c) c.style.cursor = 'pointer'
      },
      leaveEdge: () => {
        hoveredEdgeRef.current = null
        sigma.refresh()
        const c = sigma.getContainer()
        if (c) c.style.cursor = 'default'
      },
    })
  }, [registerEvents, onSelect, onDeselect, onEntitySelect, sigma])

  // ── Node/edge reducers for selection + hover highlighting ──
  useEffect(() => {
    const graph = sigma.getGraph()
    const rel = selectedRelEndpoints

    setSettings({
      nodeReducer: (node, attrs) => {
        const hNode = hoveredNodeRef.current
        if (!selectedId && !rel) {
          if (hNode === node) return { ...attrs, size: attrs.size + 1.5, forceLabel: true }
          if (hNode && graph.hasNode(hNode) && graph.areNeighbors(node, hNode)) return { ...attrs, forceLabel: true }
          return attrs
        }
        if (rel) {
          if (node === rel.sourceId || node === rel.targetId)
            return { ...attrs, size: 5, color: '#ffffff', zIndex: 2, forceLabel: true }
          return { ...attrs, color: '#222222', size: 1.5, zIndex: 0, label: null }
        }
        if (!graph.hasNode(selectedId!)) return attrs
        if (node === selectedId) return { ...attrs, size: 5, color: '#ffffff', zIndex: 2, forceLabel: true }
        if (graph.areNeighbors(node, selectedId!)) return { ...attrs, size: 3.5, zIndex: 1, forceLabel: true }
        return { ...attrs, color: '#222222', size: 1.5, zIndex: 0, label: null }
      },
      edgeReducer: (edge, attrs) => {
        const hEdge = hoveredEdgeRef.current
        if (!selectedId && !rel) {
          if (hEdge === edge) return { ...attrs, size: 1.5, color: '#666666', zIndex: 1 }
          return attrs
        }
        if (rel) {
          if (edge === rel.edgeId) return { ...attrs, size: 1.5, color: '#ffffff', zIndex: 2 }
          return { ...attrs, color: '#111111', size: 0.2, zIndex: 0 }
        }
        if (!graph.hasNode(selectedId!)) return attrs
        const source = graph.source(edge)
        const target = graph.target(edge)
        if (source === selectedId || target === selectedId)
          return { ...attrs, size: 1, color: attrs.color, zIndex: 1 }
        return { ...attrs, color: '#111111', size: 0.2, zIndex: 0 }
      },
    })
  }, [selectedId, selectedRelEndpoints, sigma, setSettings])

  return null
}

// ---------------------------------------------------------------------------
// MapView
// ---------------------------------------------------------------------------

interface MapViewProps {
  client: ArkeInstanceClient
  nodeCap?: number
  selectId?: string
  onEntitySelect?: (entityId: string) => void
  onEntityDeselect?: () => void
}

export function MapView({
  client,
  nodeCap = 50000,
  selectId,
  onEntitySelect,
  onEntityDeselect,
}: MapViewProps) {
  const data = useMapData(client, nodeCap)
  const { nodes, edges, spaces, loading, fetchRelationships, ensureEntity, resetView } = data

  const [selectedId, setSelectedId] = useState<string | null>(selectId ?? null)
  const [selectedEntity, setSelectedEntity] = useState<LoadedEntity | null>(null)

  // Load detail entity when selection changes
  const selectEntity = useCallback(
    async (id: string) => {
      setSelectedId(id)
      onEntitySelect?.(id)
      const loaded = await fetchRelationships(id)
      if (loaded) {
        if (loaded.entity.kind === 'relationship') {
          try {
            loaded.triplet = await client.getRelationship(id)
          } catch { /* ignore */ }
        }
        setSelectedEntity(loaded)
      }
    },
    [fetchRelationships, onEntitySelect, client],
  )

  // Ensure deep-linked entity is in the graph
  useEffect(() => {
    if (selectId) ensureEntity(selectId)
  }, [selectId, ensureEntity])

  const selectedRelEndpoints = useMemo(() => {
    if (!selectedEntity || selectedEntity.entity.kind !== 'relationship') return null
    const triplet = selectedEntity.triplet
    if (!triplet) return null
    return { sourceId: triplet.source_id, targetId: triplet.target_id, edgeId: selectedId! }
  }, [selectedEntity, selectedId])

  const loadedEntityIds = useMemo(() => new Set(nodes.keys()), [nodes])

  return (
    <div className="w-full h-full bg-[#0a0a0a] relative" style={{ paddingTop: '40px' }}>
      <SigmaContainer
        graph={Graph}
        style={{ width: '100%', height: '100%', background: '#0a0a0a' }}
        settings={{
          allowInvalidContainer: true,
          renderLabels: true,
          labelRenderedSizeThreshold: 14,
          labelColor: { color: '#a1a1aa' },
          labelFont: 'Inter, system-ui, sans-serif',
          labelSize: 11,
          defaultNodeColor: '#d4d4d8',
          defaultEdgeColor: '#222222',
          defaultEdgeType: 'line',
          enableEdgeEvents: true,
          zIndex: true,
          minCameraRatio: 0.005,
          maxCameraRatio: 15,
        }}
      >
        <GraphSyncAndEvents
          data={data}
          edges={edges}
          spaces={spaces}
          selectId={selectId}
          selectedId={selectedId}
          selectedRelEndpoints={selectedRelEndpoints}
          onSelect={selectEntity}
          onDeselect={() => {
            setSelectedId(null)
            setSelectedEntity(null)
            onEntityDeselect?.()
          }}
          onEntitySelect={onEntitySelect}
        />
      </SigmaContainer>

      {loading && (
        <div className="absolute top-14 left-3 px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400 z-10">
          Loading...
        </div>
      )}

      {!loading && (
        <div className="absolute top-14 left-3 flex items-center gap-2 z-10">
          <div className="px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400">
            {nodes.size} entities
          </div>
          <button
            onClick={() => {
              setSelectedId(null)
              setSelectedEntity(null)
              onEntityDeselect?.()
              resetView()
            }}
            className="px-2.5 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Reload graph"
          >
            Reset
          </button>
        </div>
      )}

      {selectedId && selectedEntity && (
        <EntityPanel
          entity={selectedEntity}
          loadedEntityIds={loadedEntityIds}
          client={client}
          onNavigate={selectEntity}
          onLoadMore={() => {}}
          onClose={() => {
            setSelectedId(null)
            setSelectedEntity(null)
            onEntityDeselect?.()
          }}
        />
      )}
    </div>
  )
}
