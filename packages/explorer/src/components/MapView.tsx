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
  useStore,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { type ArkeInstanceClient } from '@/lib/arke-client'
import { type LoadedEntity, type ArkeRelationship, createLoadedEntity } from '@/lib/arke-types'
import { RequestPool } from '@/lib/request-pool'
import { useGraphLayout } from '@/hooks/useGraphLayout'
import { useMapData } from '@/hooks/useMapData'
import { getTypeColor } from '@/lib/type-colors'
import { getEntitySpaceColor } from '@/lib/space-colors'
import { GraphNode, type GraphNodeData } from './GraphNode'
import { EntityPanel } from './EntityPanel'

interface MapViewProps {
  client: ArkeInstanceClient
  nodeCap?: number
  initialSelectId?: string
  onEntitySelect?: (entityId: string) => void
}

const nodeTypes = { graphNode: GraphNode }

// Predicate-based edge colors (same as NetworkGraph)
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

const CROSS_SPACE_COLOR = '#f59e0b'

function getEdgeColor(predicate: string): string {
  return EDGE_COLORS[predicate] ?? '#52525b'
}

function getPeerId(rel: ArkeRelationship, entityId: string): string {
  return rel.source_id === entityId ? rel.target_id : rel.source_id
}

function isCrossSpace(sourceEntity?: LoadedEntity, targetEntity?: LoadedEntity): boolean {
  const sourceSpace = sourceEntity?.entity.space_ids?.[0]
  const targetSpace = targetEntity?.entity.space_ids?.[0]
  if (!sourceSpace || !targetSpace) return false
  return sourceSpace !== targetSpace
}

function MapViewInner({ client, nodeCap = 500, initialSelectId, onEntitySelect }: MapViewProps) {
  const { entities, isLoading, capReached, entityCount, fetchRelationships, resetView } = useMapData(client, nodeCap)

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectId ?? null)
  const [pinnedPositions, setPinnedPositions] = useState<Map<string, { x: number; y: number }>>(new Map())
  const zoom = useStore((s) => s.transform[2])

  // On-demand loaded entities not in the graph (e.g. relationship entities navigated to from panel)
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

  const layout = useGraphLayout(entities, pinnedPositions, undefined, 'map')

  const selectedEntity = selectedId
    ? (entities.get(selectedId) || detailEntitiesRef.current.get(selectedId) || null)
    : null

  const neighborIds = useMemo(() => {
    if (!selectedEntity) return new Set<string>()
    const ids = new Set<string>()
    const entityId = selectedEntity.entity.id
    for (const rel of selectedEntity.relationships) {
      const peerId = getPeerId(rel, entityId)
      if (entities.has(peerId)) ids.add(peerId)
    }
    return ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selectedEntity, entities])

  const rfNodes: Node[] = useMemo(() => {
    return layout.nodes.map((n) => {
      const entityId = n.entity.entity.id
      const unloadedCount = n.entity.relationships.filter(
        (r) => !entities.has(getPeerId(r, entityId))
      ).length

      const nodeData: GraphNodeData = {
        entity: n.entity,
        isSelected: n.id === selectedId,
        isNeighbor: neighborIds.has(n.id),
        hasSelection: selectedId != null,
        isSpawning: false,
        unloadedCount,
        colorMode: 'space',
        spaceColor: getEntitySpaceColor(n.entity.entity.space_ids),
      }

      return {
        id: n.id,
        type: 'graphNode',
        position: { x: n.x, y: n.y },
        data: nodeData,
      }
    })
  }, [layout.nodes, selectedId, neighborIds, entities])

  // Hide edge labels when zoomed out — they just add noise at low zoom
  const showEdgeLabels = zoom >= 0.5

  const rfEdges: Edge[] = useMemo(() => {
    return layout.edges.map((e) => {
      const isThisEdge = e.relationshipId === selectedId
      const isConnected = selectedId != null && (
        e.source === selectedId || e.target === selectedId || isThisEdge
      )

      const sourceEntity = entities.get(e.source)
      const targetEntity = entities.get(e.target)
      const crossSpace = isCrossSpace(sourceEntity, targetEntity)

      const color = crossSpace ? CROSS_SPACE_COLOR : getEdgeColor(e.predicate)

      return {
        id: e.relationshipId,
        source: e.source,
        target: e.target,
        type: 'smoothstep',
        label: showEdgeLabels ? e.predicate.replace(/_/g, ' ') : undefined,
        labelStyle: showEdgeLabels ? {
          fill: isConnected ? '#d4d4d8' : '#71717a',
          fontSize: 10,
          fontWeight: isConnected ? 600 : 500,
        } : undefined,
        labelBgStyle: showEdgeLabels ? { fill: '#0a0a0a', fillOpacity: 0.8 } : undefined,
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
          strokeWidth: crossSpace ? 2 : (isConnected ? 2.5 : 1.5),
          strokeDasharray: crossSpace ? '8 4' : undefined,
          opacity: isConnected ? 1 : (selectedId ? 0.15 : 0.4),
          cursor: 'pointer',
        },
        interactionWidth: 20,
        animated: false,
        zIndex: isConnected ? 10 : (crossSpace ? 5 : 0),
      }
    })
  }, [layout.edges, selectedId, entities, showEdgeLabels])

  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes)
  const [edges, setEdges] = useEdgesState(rfEdges)

  // Sync nodes/edges whenever they change (selection, layout, etc.)
  // Preserve user-dragged positions by merging with current RF state.
  useEffect(() => {
    setNodes((current) => {
      const currentPositions = new Map(current.map((n) => [n.id, n.position]))
      return rfNodes.map((n) => {
        const draggedPos = currentPositions.get(n.id)
        // Keep drag position if the layout position hasn't changed
        if (draggedPos && pinnedPositions.has(n.id)) {
          return { ...n, position: draggedPos }
        }
        return n
      })
    })
  }, [rfNodes, setNodes, pinnedPositions])

  useEffect(() => {
    setEdges(rfEdges)
  }, [rfEdges, setEdges])

  const selectEntity = useCallback((id: string) => {
    setSelectedId(id)
    onEntitySelect?.(id)
    fetchRelationships(id)
    loadDetailEntity(id)
  }, [onEntitySelect, fetchRelationships, loadDetailEntity])

  const handleNodeClick: NodeMouseHandler = useCallback((_event, node) => {
    selectEntity(node.id)
  }, [selectEntity])

  const handleEdgeClick = useCallback((_event: React.MouseEvent, edge: Edge) => {
    // Edge ID is the relationship entity ID — load and select it
    selectEntity(edge.id)
  }, [selectEntity])

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
    return new Set(entities.keys())
  }, [entities])

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
        fitViewOptions={{ padding: 0.5, maxZoom: 0.6 }}
        minZoom={0.05}
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
            return data.spaceColor ?? getTypeColor(data.entity.entity.type)
          }}
          maskColor="rgba(0,0,0,0.7)"
        />
      </ReactFlow>

      {/* Loading indicator */}
      {isLoading && (
        <div className="absolute top-3 left-3 px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400">
          Loading entities...
        </div>
      )}

      {/* Entity count */}
      {!isLoading && (
        <div className="absolute top-3 left-3 px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400">
          {entityCount} entities
        </div>
      )}

      {/* Cap reached banner */}
      {capReached && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-zinc-800/95 border border-zinc-700 rounded-lg text-xs text-zinc-300">
          <span>Graph limit reached ({nodeCap} nodes)</span>
          <button
            onClick={resetView}
            className="px-2 py-0.5 bg-zinc-700 hover:bg-zinc-600 rounded text-zinc-200 transition-colors"
          >
            Reset
          </button>
        </div>
      )}

      {/* Entity panel */}
      {selectedId && (entities.get(selectedId) || detailEntitiesRef.current.get(selectedId)) && (
        <EntityPanel
          entity={(entities.get(selectedId) || detailEntitiesRef.current.get(selectedId))!}
          loadedEntityIds={loadedEntityIds}
          client={client}
          onNavigate={selectEntity}
          onLoadMore={() => {}}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  )
}

export function MapView(props: MapViewProps) {
  return (
    <ReactFlowProvider>
      <MapViewInner {...props} />
    </ReactFlowProvider>
  )
}
