// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  PanOnScrollMode,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { type ArkeInstanceClient } from '@/lib/arke-client'
import { type LoadedEntity, type ArkeRelationship, createLoadedEntity } from '@/lib/arke-types'
import { RequestPool } from '@/lib/request-pool'
import { useGraphLayout } from '@/hooks/useGraphLayout'
import { getTypeColor } from '@/lib/type-colors'
import { GraphNode, type GraphNodeData } from './GraphNode'
import { EntityPanel } from './EntityPanel'

interface NetworkGraphProps {
  client: ArkeInstanceClient
  seedEntityId: string
  seedEntityIds?: string[]
  onEntitySelect?: (entityId: string) => void
}

const nodeTypes = { graphNode: GraphNode }

// Predicate-based edge colors
const EDGE_COLORS: Record<string, string> = {
  contains: '#22c55e',
  references: '#3b82f6',
  relates_to: '#8b5cf6',
  created_by: '#f59e0b',
  owned_by: '#ec4899',
  prior_art_for: '#06b6d4',
  influenced: '#f97316',
  enables: '#84cc16',
}

function getEdgeColor(predicate: string): string {
  return EDGE_COLORS[predicate] ?? '#52525b'
}

/** Get the peer ID from a relationship given the current entity's ID */
function getPeerId(rel: ArkeRelationship, entityId: string): string {
  return rel.source_id === entityId ? rel.target_id : rel.source_id
}

function NetworkGraphInner({ client, seedEntityId, seedEntityIds, onEntitySelect }: NetworkGraphProps) {
  const loadedEntitiesRef = useRef<Map<string, LoadedEntity>>(new Map())
  const [renderCount, setRenderCount] = useState(0)
  const rerender = useCallback(() => setRenderCount((n) => n + 1), [])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set())
  const loadingIdsRef = useRef<Set<string>>(new Set())
  const [pinnedPositions, setPinnedPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const [spawningIds, setSpawningIds] = useState<Set<string>>(new Set())

  // Lazy init so StrictMode's double-invocation doesn't create two pools
  // (one of which would be orphaned and never used).
  const poolRef = useRef<RequestPool | null>(null)
  if (poolRef.current === null) poolRef.current = new RequestPool(8)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadEntity = useCallback(async (id: string): Promise<LoadedEntity | null> => {
    if (loadedEntitiesRef.current.has(id)) {
      return loadedEntitiesRef.current.get(id)!
    }

    if (loadingIdsRef.current.has(id)) return null

    loadingIdsRef.current.add(id)
    setLoadingIds((prev) => new Set(prev).add(id))

    try {
      // Fetch entity and relationships in parallel
      const [entity, relResult] = await poolRef.current!.execute(
        () => Promise.all([client.getEntity(id), client.getRelationships(id)]),
        `entity:${id}`
      )

      if (!mountedRef.current) return null

      const loaded = createLoadedEntity(entity, relResult.relationships, relResult.outCursor, relResult.inCursor)

      // If this is a relationship entity, fetch triplet data (source, target, predicate)
      if (entity.kind === 'relationship') {
        try {
          loaded.triplet = await poolRef.current!.execute(
            () => client.getRelationship(id),
            `relationship:${id}`
          )
        } catch (err) {
          console.error(`Failed to load triplet for ${id}:`, err)
        }
      }

      loadedEntitiesRef.current.set(id, loaded)

      // Mark as spawning for animation
      setSpawningIds((prev) => new Set(prev).add(id))
      setTimeout(() => {
        if (!mountedRef.current) return
        setSpawningIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, 2500)

      rerender()
      return loaded
    } catch (err) {
      console.error(`Failed to load entity ${id}:`, err)
      return null
    } finally {
      loadingIdsRef.current.delete(id)
      if (mountedRef.current) {
        setLoadingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
  }, [client, rerender])

  const autoExpand = useCallback(async (entity: LoadedEntity, limit = 3) => {
    const entityId = entity.entity.id
    // Only auto-expand outgoing relationships
    const outgoingPeers = entity.relationships
      .filter((r) => r.source_id === entityId)
      .map((r) => r.target_id)
      .filter((peerId) => !loadedEntitiesRef.current.has(peerId) && !loadingIdsRef.current.has(peerId))
      .slice(0, limit)

    await Promise.all(outgoingPeers.map((peerId) => loadEntity(peerId)))
  }, [loadEntity])

  const loadMoreRelationships = useCallback(async (id: string) => {
    const existing = loadedEntitiesRef.current.get(id)
    if (!existing || !existing.hasMore) return

    try {
      const result = await client.getMoreRelationships(id, existing.outCursor, existing.inCursor)
      if (!mountedRef.current) return

      // Deduplicate against already-loaded relationships
      const existingIds = new Set(existing.relationships.map((r) => r.id))
      const newRels = result.relationships.filter((r) => !existingIds.has(r.id))

      const updated: LoadedEntity = {
        ...existing,
        relationships: [...existing.relationships, ...newRels],
        outCursor: result.outCursor,
        inCursor: result.inCursor,
        hasMore: result.hasMore,
      }
      loadedEntitiesRef.current.set(id, updated)
      rerender()
    } catch (err) {
      console.error(`Failed to load more relationships for ${id}:`, err)
    }
  }, [client, rerender])

  const loadAndSelect = useCallback(async (id: string, updateUrl = true) => {
    setSelectedId(id)

    // Notify parent to update URL
    if (updateUrl) {
      onEntitySelect?.(id)
    }

    // Only auto-expand if this entity is being loaded for the first time
    const alreadyLoaded = loadedEntitiesRef.current.has(id)
    let loaded: LoadedEntity | null = loadedEntitiesRef.current.get(id) ?? null
    if (!loaded) {
      loaded = await loadEntity(id)
    }

    if (loaded) {
      // If this is a relationship, ensure source and target are in the graph
      if (loaded.entity.kind === 'relationship' && loaded.triplet) {
        await Promise.all([
          loadEntity(loaded.triplet.source_id),
          loadEntity(loaded.triplet.target_id),
        ])
      } else if (!alreadyLoaded) {
        await autoExpand(loaded, 3)
      }
    }
  }, [loadEntity, autoExpand, onEntitySelect])

  // Initial load
  const initialLoadDone = useRef(false)
  useEffect(() => {
    if (initialLoadDone.current) return
    initialLoadDone.current = true

    async function init() {
      const seeds = seedEntityIds && seedEntityIds.length > 0 ? seedEntityIds : [seedEntityId]
      setSelectedId(seeds[0])

      for (let i = 0; i < seeds.length; i++) {
        const loaded = await loadEntity(seeds[i])
        if (loaded) {
          if (loaded.entity.kind === 'relationship' && loaded.triplet) {
            const [source, target] = await Promise.all([
              loadEntity(loaded.triplet.source_id),
              loadEntity(loaded.triplet.target_id),
            ])
            if (source) await autoExpand(source, 3)
            if (target) await autoExpand(target, 3)
          } else {
            // First seed gets 5 auto-expanded, rest get 3
            await autoExpand(loaded, i === 0 ? 5 : 3)
          }
        }
      }
    }
    init()
  }, [seedEntityId, seedEntityIds, loadEntity, autoExpand])

  // Handle browser back/forward
  useEffect(() => {
    const handler = () => {
      const params = new URLSearchParams(window.location.search)
      const entityId = params.get('select')
      if (entityId) {
        loadAndSelect(entityId, false) // false = don't push to history again
      }
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [loadAndSelect])

  // Create a stable snapshot of entities for layout, excluding relationship entities
  // (relationships are represented as edges, not nodes)
  const entitiesSnapshot = useMemo(() => {
    const snapshot = new Map<string, LoadedEntity>()
    for (const [id, entity] of loadedEntitiesRef.current) {
      if (entity.entity.kind !== 'relationship') {
        snapshot.set(id, entity)
      }
    }
    return snapshot
    // renderCount triggers this to recalculate when entities change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderCount])

  const layout = useGraphLayout(entitiesSnapshot, pinnedPositions)

  // Build ReactFlow nodes and edges
  const selectedEntity = selectedId ? loadedEntitiesRef.current.get(selectedId) : null

  // When a relationship is selected, derive the triplet source/target for highlighting
  const selectedTriplet = useMemo(() => {
    if (!selectedEntity?.triplet || selectedEntity.entity.kind !== 'relationship') return null
    return {
      sourceId: selectedEntity.triplet.source_id,
      targetId: selectedEntity.triplet.target_id,
      relationshipId: selectedEntity.entity.id,
    }
  }, [selectedEntity])

  const neighborIds = useMemo(() => {
    if (!selectedEntity) return new Set<string>()
    const ids = new Set<string>()

    // Relationship selected: neighbors are triplet source + target
    if (selectedTriplet) {
      if (loadedEntitiesRef.current.has(selectedTriplet.sourceId)) ids.add(selectedTriplet.sourceId)
      if (loadedEntitiesRef.current.has(selectedTriplet.targetId)) ids.add(selectedTriplet.targetId)
      return ids
    }

    // Normal entity selected: neighbors are connected peers
    const entityId = selectedEntity.entity.id
    for (const rel of selectedEntity.relationships) {
      const peerId = getPeerId(rel, entityId)
      if (loadedEntitiesRef.current.has(peerId)) {
        ids.add(peerId)
      }
    }
    return ids
  }, [selectedEntity, selectedTriplet])

  const rfNodes: Node[] = useMemo(() => {
    return layout.nodes.map((n) => {
      const entityId = n.entity.entity.id
      const unloadedCount = n.entity.relationships.filter(
        (r) => !loadedEntitiesRef.current.has(getPeerId(r, entityId))
      ).length

      const nodeData: GraphNodeData = {
        entity: n.entity,
        isSelected: n.id === selectedId,
        isNeighbor: neighborIds.has(n.id),
        hasSelection: selectedId != null,
        isSpawning: spawningIds.has(n.id),
        unloadedCount,
      }

      return {
        id: n.id,
        type: 'graphNode',
        position: { x: n.x, y: n.y },
        data: nodeData,
      }
    })
  }, [layout.nodes, selectedId, neighborIds, spawningIds])

  const rfEdges: Edge[] = useMemo(() => {
    return layout.edges.map((e) => {
      const isConnected = selectedId != null && (
        // Node selected: highlight edges touching that node
        e.source === selectedId || e.target === selectedId ||
        // Relationship selected: highlight this specific edge
        e.relationshipId === selectedId
      )
      const color = getEdgeColor(e.predicate)

      return {
        id: e.relationshipId,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        label: e.predicate.replace(/_/g, ' '),
        labelStyle: {
          fill: isConnected ? '#d4d4d8' : '#71717a',
          fontSize: 10,
          fontWeight: isConnected ? 600 : 500,
        },
        labelBgStyle: { fill: '#0a0a0a', fillOpacity: 0.8 },
        labelBgPadding: [4, 2] as [number, number],
        labelBgBorderRadius: 3,
        markerEnd: {
          type: 'arrowclosed' as const,
          color,
          width: 16,
          height: 16,
        },
        style: {
          stroke: color,
          strokeWidth: isConnected ? 2.5 : 1.5,
          opacity: isConnected ? 1 : (selectedId ? 0.2 : 0.5),
          cursor: 'pointer',
        },
        interactionWidth: 20,
        animated: false,
        zIndex: isConnected ? 10 : 0,
      }
    })
  }, [layout.edges, selectedId])

  // Use ReactFlow's internal state for smooth dragging
  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes)
  const [edges, setEdges] = useEdgesState(rfEdges)

  // Sync layout-computed nodes/edges into ReactFlow state when they change
  // but preserve ReactFlow's own position updates during drag
  const prevLayoutRef = useRef(layout)
  useEffect(() => {
    if (layout !== prevLayoutRef.current) {
      prevLayoutRef.current = layout
      setNodes(rfNodes)
    }
  }, [rfNodes, layout, setNodes])

  useEffect(() => {
    setEdges(rfEdges)
  }, [rfEdges, setEdges])

  const handleNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    loadAndSelect(node.id)
  }, [loadAndSelect])

  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    loadAndSelect(edge.id)
  }, [loadAndSelect])

  const handleNodeDragStop: NodeMouseHandler = useCallback((_event, node) => {
    setPinnedPositions((prev) => {
      const next = new Map(prev)
      next.set(node.id, { x: node.position.x, y: node.position.y })
      return next
    })
  }, [])

  const handlePaneClick = useCallback(() => {
    setSelectedId(null)
  }, [])

  const loadedEntityIds = useMemo(() => {
    return new Set(loadedEntitiesRef.current.keys())
  }, [rfNodes]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="w-full h-full bg-[#0a0a0a] relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onEdgeClick={handleEdgeClick}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 0.8 }}
        minZoom={0.1}
        maxZoom={2}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Free}
        zoomOnScroll={false}
        zoomOnPinch={true}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#333" gap={20} />
        <MiniMap
          style={{ backgroundColor: '#18181b' }}
          nodeColor={(node) => {
            const data = node.data as unknown as GraphNodeData
            return getTypeColor(data.entity.entity.type)
          }}
          maskColor="rgba(0,0,0,0.7)"
        />
      </ReactFlow>

      {/* Loading indicator */}
      {loadingIds.size > 0 && (
        <div className="absolute top-3 left-3 px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400">
          Loading {loadingIds.size} {loadingIds.size === 1 ? 'entity' : 'entities'}...
        </div>
      )}

      {/* Entity panel */}
      {selectedId && loadedEntitiesRef.current.get(selectedId) && (
        <EntityPanel
          entity={loadedEntitiesRef.current.get(selectedId)!}
          loadedEntityIds={loadedEntityIds}
          client={client}
          onNavigate={loadAndSelect}
          onLoadMore={() => loadMoreRelationships(selectedId!)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

export function NetworkGraph(props: NetworkGraphProps) {
  return (
    <ReactFlowProvider>
      <NetworkGraphInner {...props} />
    </ReactFlowProvider>
  )
}
