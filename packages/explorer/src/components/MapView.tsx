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
import { type LoadedEntity, type ArkeRelationship, createLoadedEntity } from '@/lib/arke-types'
import { RequestPool } from '@/lib/request-pool'
import { useMapData, type UseMapDataResult } from '@/hooks/useMapData'
import { getEntitySpaceColor } from '@/lib/space-colors'
import { EntityPanel } from './EntityPanel'

interface MapViewProps {
  client: ArkeInstanceClient
  nodeCap?: number
  selectId?: string
  onEntitySelect?: (entityId: string) => void
  onEntityDeselect?: () => void
}

function getPeerId(rel: ArkeRelationship, entityId: string): string {
  return rel.source_id === entityId ? rel.target_id : rel.source_id
}

interface GraphEventsProps {
  data: UseMapDataResult
  client: ArkeInstanceClient
  selectId?: string
  selectedId: string | null
  /** When a relationship is selected, the source and target node IDs */
  selectedRelEndpoints: { sourceId: string; targetId: string; edgeId: string } | null
  onSelect: (id: string) => void
  onDeselect: () => void
  onEntitySelect?: (entityId: string) => void
}

function GraphSyncAndEvents({
  data,
  client,
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
  const { entities, isLoading, bulkLoadComplete, fetchRelationships } = data
  const layoutDoneRef = useRef(false)
  const hoveredNodeRef = useRef<string | null>(null)
  const hoveredEdgeRef = useRef<string | null>(null)
  const prevBulkCompleteRef = useRef(false)

  // Clear the graphology graph when resetView triggers (bulkLoadComplete goes false)
  useEffect(() => {
    if (prevBulkCompleteRef.current && !bulkLoadComplete) {
      const graph = sigma.getGraph()
      graph.clear()
      layoutDoneRef.current = false
      sigma.getCamera().setState({ x: 0.5, y: 0.5, angle: 0, ratio: 1 })
    }
    prevBulkCompleteRef.current = bulkLoadComplete
  }, [bulkLoadComplete, sigma])

  // Sync entities into graphology and run layout.
  // During bulk load: add nodes/edges silently (no layout yet).
  // Once bulk load completes: run full FA2 with component separation.
  // After that: incremental layout for polling updates.
  useEffect(() => {
    const graph = sigma.getGraph()

    // Add any new nodes and edges
    let addedNodes = 0
    for (const [id, loaded] of entities) {
      if (!graph.hasNode(id)) {
        const angle = Math.random() * Math.PI * 2
        const dist = Math.random() * 100
        graph.addNode(id, {
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          size: 2,
          color: getEntitySpaceColor(loaded.entity.space_ids),
          label: (loaded.entity.properties?.label as string) || loaded.entity.type,
          type: 'circle',
        })
        addedNodes++
      }

      for (const rel of loaded.relationships) {
        if (rel.predicate === 'collection') continue
        const peerId = getPeerId(rel, id)
        if (!entities.has(peerId)) continue
        if (!graph.hasNode(rel.source_id) || !graph.hasNode(rel.target_id)) continue
        if (graph.hasEdge(rel.id)) continue
        try {
          graph.addEdgeWithKey(rel.id, rel.source_id, rel.target_id, {
            color: '#333333',
            size: 0.5,
            predicate: rel.predicate,
            type: 'line',
          })
        } catch {}
      }
    }

    // During bulk load, just accumulate data — don't layout yet
    if (!bulkLoadComplete) return

    // Skip if no nodes in the graph, or if layout already ran and no new nodes arrived
    if (graph.order === 0) return
    if (addedNodes === 0 && layoutDoneRef.current) return

    const inferred = forceAtlas2.inferSettings(graph)
    const settings = {
      ...inferred,
      gravity: 1,
      scalingRatio: 10,
      strongGravityMode: false,
      barnesHutOptimize: graph.order > 500,
    }

    if (!layoutDoneRef.current) {
      layoutDoneRef.current = true

      // Spread disconnected components apart before layout
      const visited = new Set<string>()
      const components: string[][] = []
      graph.forEachNode((node) => {
        if (visited.has(node)) return
        const component: string[] = []
        const queue = [node]
        while (queue.length > 0) {
          const n = queue.pop()!
          if (visited.has(n)) continue
          visited.add(n)
          component.push(n)
          graph.forEachNeighbor(n, (neighbor) => {
            if (!visited.has(neighbor)) queue.push(neighbor)
          })
        }
        components.push(component)
      })

      if (components.length > 1) {
        const totalNodes = graph.order
        let angleOffset = 0
        for (const comp of components) {
          const radius = Math.sqrt(totalNodes) * 50
          const cx = Math.cos(angleOffset) * radius
          const cy = Math.sin(angleOffset) * radius
          for (const nodeId of comp) {
            const attrs = graph.getNodeAttributes(nodeId)
            graph.setNodeAttribute(nodeId, 'x', attrs.x + cx)
            graph.setNodeAttribute(nodeId, 'y', attrs.y + cy)
          }
          angleOffset += (comp.length / totalNodes) * Math.PI * 2
        }
      }

      // Scale iterations down for large graphs to avoid UI freeze
      // (FA2 runs synchronously on main thread)
      const iters = graph.order <= 200 ? 150 : graph.order <= 1000 ? 80 : graph.order <= 3000 ? 50 : 30
      forceAtlas2.assign(graph, { iterations: iters, settings })
    } else {
      // Incremental: settle new nodes from polling
      forceAtlas2.assign(graph, { iterations: 15, settings })
    }
  }, [entities, bulkLoadComplete, sigma])

  // Zoom to selected entity after layout completes
  useEffect(() => {
    if (!selectId || !layoutDoneRef.current) return
    const graph = sigma.getGraph()
    if (!graph.hasNode(selectId)) return

    // Force re-process, then zoom after Sigma renders with correct positions.
    // getNodeDisplayData returns framedGraph coords — pass directly to camera.
    sigma.refresh()
    const handler = () => {
      sigma.off('afterRender', handler)
      const data = sigma.getNodeDisplayData(selectId)
      if (!data) return
      sigma.getCamera().animate(
        { x: data.x, y: data.y, ratio: 0.1 },
        { duration: 600 },
      )
    }
    sigma.on('afterRender', handler)
    onSelect(selectId)
    fetchRelationships(selectId)
    return () => { sigma.off('afterRender', handler) }
  }, [selectId, bulkLoadComplete, sigma, onSelect, fetchRelationships])

  // Register click and hover events
  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => {
        onSelect(node)
        onEntitySelect?.(node)
        fetchRelationships(node)
      },
      clickEdge: ({ edge }) => {
        onSelect(edge)
        onEntitySelect?.(edge)
      },
      clickStage: () => {
        onDeselect()
      },
      enterNode: ({ node }) => {
        hoveredNodeRef.current = node
        sigma.refresh()
        const container = sigma.getContainer()
        if (container) container.style.cursor = 'pointer'
      },
      leaveNode: () => {
        hoveredNodeRef.current = null
        sigma.refresh()
        const container = sigma.getContainer()
        if (container) container.style.cursor = 'default'
      },
      enterEdge: ({ edge }) => {
        hoveredEdgeRef.current = edge
        sigma.refresh()
        const container = sigma.getContainer()
        if (container) container.style.cursor = 'pointer'
      },
      leaveEdge: () => {
        hoveredEdgeRef.current = null
        sigma.refresh()
        const container = sigma.getContainer()
        if (container) container.style.cursor = 'default'
      },
    })
  }, [registerEvents, onSelect, onDeselect, onEntitySelect, fetchRelationships, sigma])

  // Node/edge reducers for selection and hover highlighting.
  // Hover state lives in refs (not React state) to avoid re-renders on every
  // mouse move — sigma.refresh() in the event handlers triggers a redraw that
  // re-evaluates the reducers, reading the current ref values.
  useEffect(() => {
    const graph = sigma.getGraph()
    const rel = selectedRelEndpoints

    setSettings({
      nodeReducer: (node, attrs) => {
        const hNode = hoveredNodeRef.current
        // Hover feedback (when nothing selected)
        if (!selectedId && !rel) {
          if (hNode === node) {
            return { ...attrs, size: attrs.size + 1.5, forceLabel: true }
          }
          if (hNode && graph.areNeighbors(node, hNode)) {
            return { ...attrs, forceLabel: true }
          }
          return attrs
        }

        // Relationship selected — highlight both endpoints
        if (rel) {
          if (node === rel.sourceId || node === rel.targetId) {
            return { ...attrs, size: 5, color: '#ffffff', zIndex: 2, forceLabel: true }
          }
          return { ...attrs, color: '#222222', size: 1.5, zIndex: 0, label: null }
        }

        // If selected ID isn't a graph node (e.g. detail entity), don't dim
        if (!graph.hasNode(selectedId!)) return attrs

        // Node selected
        if (node === selectedId) {
          return { ...attrs, size: 5, color: '#ffffff', zIndex: 2, forceLabel: true }
        }
        if (graph.areNeighbors(node, selectedId!)) {
          return { ...attrs, size: 3.5, zIndex: 1, forceLabel: true }
        }
        return { ...attrs, color: '#222222', size: 1.5, zIndex: 0, label: null }
      },
      edgeReducer: (edge, attrs) => {
        const hEdge = hoveredEdgeRef.current
        // Hover feedback (when nothing selected)
        if (!selectedId && !rel) {
          if (hEdge === edge) {
            return { ...attrs, size: 1.5, color: '#666666', zIndex: 1 }
          }
          return attrs
        }

        // Relationship selected — highlight the specific edge
        if (rel) {
          if (edge === rel.edgeId) {
            return { ...attrs, size: 1.5, color: '#ffffff', zIndex: 2 }
          }
          return { ...attrs, color: '#111111', size: 0.2, zIndex: 0 }
        }

        // If selected ID isn't a graph node, don't dim
        if (!graph.hasNode(selectedId!)) return attrs

        // Node selected — highlight connected edges
        const source = graph.source(edge)
        const target = graph.target(edge)
        if (source === selectedId || target === selectedId) {
          return { ...attrs, size: 1, color: attrs.color, zIndex: 1 }
        }
        return { ...attrs, color: '#111111', size: 0.2, zIndex: 0 }
      },
    })
  }, [selectedId, selectedRelEndpoints, sigma, setSettings])

  return null
}

export function MapView({ client, nodeCap = 3000, selectId, onEntitySelect, onEntityDeselect }: MapViewProps) {
  const data = useMapData(client, nodeCap, selectId)
  const { entities, isLoading, entityCount, fetchRelationships, ensureEntity, resetView } = data

  const [selectedId, setSelectedId] = useState<string | null>(selectId ?? null)

  const detailEntitiesRef = useRef<Map<string, LoadedEntity>>(new Map())
  const [, setDetailRender] = useState(0)
  const detailPoolRef = useRef<RequestPool | null>(null)
  if (detailPoolRef.current === null) detailPoolRef.current = new RequestPool(4)

  const loadDetailEntity = useCallback(async (id: string) => {
    if (entities.has(id) || detailEntitiesRef.current.has(id)) return
    try {
      const [entity, rels] = await detailPoolRef.current!.execute(
        () => Promise.all([client.getEntity(id), client.getRelationships(id)]),
        `detail:${id}`
      )
      const loaded = createLoadedEntity(entity, rels.relationships, rels.outCursor, rels.inCursor)
      if (entity.kind === 'relationship') {
        try {
          loaded.triplet = await client.getRelationship(id)
        } catch {}
      }
      detailEntitiesRef.current.set(id, loaded)
      setDetailRender(n => n + 1)
    } catch (err) {
      console.error(`Failed to load detail entity ${id}:`, err)
    }
  }, [client, entities])

  const selectEntity = useCallback((id: string) => {
    setSelectedId(id)
    onEntitySelect?.(id)
    ensureEntity(id)
    fetchRelationships(id)
    loadDetailEntity(id)
  }, [onEntitySelect, ensureEntity, fetchRelationships, loadDetailEntity])

  const selectedEntity = selectedId
    ? (entities.get(selectedId) || detailEntitiesRef.current.get(selectedId) || null)
    : null

  // When a relationship entity is selected, compute the endpoints for highlighting
  const selectedRelEndpoints = useMemo(() => {
    if (!selectedEntity) return null
    if (selectedEntity.entity.kind !== 'relationship') return null
    const triplet = selectedEntity.triplet
    if (!triplet) return null
    return { sourceId: triplet.source_id, targetId: triplet.target_id, edgeId: selectedId! }
  }, [selectedEntity, selectedId])

  const loadedEntityIds = useMemo(() => new Set(entities.keys()), [entities])

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
          client={client}
          selectId={selectId}
          selectedId={selectedId}
          selectedRelEndpoints={selectedRelEndpoints}
          onSelect={selectEntity}
          onDeselect={() => { setSelectedId(null); onEntityDeselect?.() }}
          onEntitySelect={onEntitySelect}
        />
      </SigmaContainer>

      {!data.bulkLoadComplete && (
        <div className="absolute top-14 left-3 px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400 z-10">
          Loading {entityCount} entities...
        </div>
      )}

      {data.bulkLoadComplete && (
        <div className="absolute top-14 left-3 flex items-center gap-2 z-10">
          <div className="px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400">
            {entityCount} entities
          </div>
          <button
            onClick={() => {
              setSelectedId(null)
              onEntityDeselect?.()
              resetView()
            }}
            className="px-2.5 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            title="Clear cached graph and reload all data"
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
          onClose={() => { setSelectedId(null); onEntityDeselect?.() }}
        />
      )}
    </div>
  )
}
