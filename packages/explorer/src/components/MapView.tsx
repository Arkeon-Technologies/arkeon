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
}

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

function getPeerId(rel: ArkeRelationship, entityId: string): string {
  return rel.source_id === entityId ? rel.target_id : rel.source_id
}

function colorToHex(color: string): string {
  if (color.startsWith('#')) return color
  const m = color.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/)
  if (!m) return color
  const h = parseFloat(m[1])
  const s = parseFloat(m[2]) / 100
  const l = parseFloat(m[3]) / 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const c = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * c).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
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
  const { entities, isLoading, fetchRelationships } = data

  const initialLayoutDoneRef = useRef(false)

  // Sync entity data into graphology graph
  useEffect(() => {
    if (isLoading) return
    const graph = sigma.getGraph()

    let addedNodes = 0

    for (const [id, loaded] of entities) {
      if (!graph.hasNode(id)) {
        const angle = Math.random() * Math.PI * 2
        const dist = Math.random() * 100
        graph.addNode(id, {
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          size: 5,
          color: colorToHex(getEntitySpaceColor(loaded.entity.space_ids)),
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
            color: colorToHex(getEdgeColor(rel.predicate)),
            size: 1,
            predicate: rel.predicate,
            type: 'arrow',
          })
        } catch {
          // Edge may already exist
        }
      }
    }

    if (addedNodes > 0) {
      const inferred = forceAtlas2.inferSettings(graph)
      // Low gravity lets clusters form naturally instead of one dense ball.
      // Higher scalingRatio spreads nodes apart within clusters.
      const settings = {
        ...inferred,
        gravity: 1,
        scalingRatio: 10,
        strongGravityMode: false,
        barnesHutOptimize: graph.order > 500,
      }
      if (!initialLayoutDoneRef.current) {
        initialLayoutDoneRef.current = true
        const iters = graph.order <= 200 ? 150 : graph.order <= 1000 ? 100 : 60
        forceAtlas2.assign(graph, { iterations: iters, settings })
      } else {
        forceAtlas2.assign(graph, { iterations: 15, settings })
      }
    }
  }, [entities, isLoading, sigma])

  // Zoom to selected entity when selectId prop changes
  useEffect(() => {
    if (!selectId) return
    if (isLoading) return
    const graph = sigma.getGraph()
    if (!graph.hasNode(selectId)) return

    const timer = setTimeout(() => {
      // Sigma camera coords are in the graph coordinate space after normalization.
      // getNodeAttributes gives us the raw graph coordinates.
      const attrs = graph.getNodeAttributes(selectId)
      const camera = sigma.getCamera()
      // Use sigma's normalization: convert graph coords to framed graph coords
      const { x: normX, y: normY } = sigma.graphToFramedGraph(attrs as { x: number; y: number })
      camera.animate({ x: normX, y: normY, ratio: 0.1 }, { duration: 600 })
      onSelect(selectId)
      fetchRelationships(selectId)
    }, 300)
    return () => clearTimeout(timer)
  }, [selectId, isLoading, sigma, onSelect, fetchRelationships])

  // Register click events
  useEffect(() => {
    registerEvents({
      clickNode: ({ node }) => {
        onSelect(node)
        onEntitySelect?.(node)
        fetchRelationships(node)
      },
      clickEdge: ({ edge }) => {
        // Edge ID is the relationship entity ID — select it to show in EntityPanel
        onSelect(edge)
        onEntitySelect?.(edge)
      },
      clickStage: () => {
        onDeselect()
      },
    })
  }, [registerEvents, onSelect, onDeselect, onEntitySelect, fetchRelationships])

  // Node/edge reducers for selection highlighting
  useEffect(() => {
    const graph = sigma.getGraph()
    const rel = selectedRelEndpoints

    setSettings({
      nodeReducer: (node, attrs) => {
        if (!selectedId && !rel) return attrs

        // Relationship selected — highlight both endpoints
        if (rel) {
          if (node === rel.sourceId || node === rel.targetId) {
            return { ...attrs, size: 10, color: '#ffffff', zIndex: 2 }
          }
          return { ...attrs, color: '#333333', size: 3, zIndex: 0 }
        }

        // Node selected
        if (node === selectedId) {
          return { ...attrs, size: 10, color: '#ffffff', zIndex: 2 }
        }
        const isNeighbor = graph.hasNode(selectedId!) && graph.areNeighbors(node, selectedId!)
        if (isNeighbor) {
          return { ...attrs, size: 7, zIndex: 1 }
        }
        return { ...attrs, color: '#333333', size: 3, zIndex: 0 }
      },
      edgeReducer: (edge, attrs) => {
        if (!selectedId && !rel) return attrs

        // Relationship selected — highlight the specific edge
        if (rel) {
          if (edge === rel.edgeId) {
            return { ...attrs, size: 3, color: '#ffffff', zIndex: 2 }
          }
          return { ...attrs, color: '#1a1a1a', size: 0.5, zIndex: 0 }
        }

        // Node selected — highlight connected edges
        const source = graph.source(edge)
        const target = graph.target(edge)
        if (source === selectedId || target === selectedId) {
          return { ...attrs, size: 2, zIndex: 1 }
        }
        return { ...attrs, color: '#1a1a1a', size: 0.5, zIndex: 0 }
      },
    })
  }, [selectedId, selectedRelEndpoints, sigma, setSettings])

  return null
}

export function MapView({ client, nodeCap = 10000, selectId, onEntitySelect }: MapViewProps) {
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
          labelRenderedSizeThreshold: 8,
          labelColor: { color: '#a1a1aa' },
          labelFont: 'Inter, system-ui, sans-serif',
          labelSize: 12,
          defaultNodeColor: '#52525b',
          defaultEdgeColor: '#333333',
          defaultEdgeType: 'arrow',
          enableEdgeEvents: true,
          zIndex: true,
          minCameraRatio: 0.01,
          maxCameraRatio: 10,
        }}
      >
        <GraphSyncAndEvents
          data={data}
          client={client}
          selectId={selectId}
          selectedId={selectedId}
          selectedRelEndpoints={selectedRelEndpoints}
          onSelect={selectEntity}
          onDeselect={() => setSelectedId(null)}
          onEntitySelect={onEntitySelect}
        />
      </SigmaContainer>

      {isLoading && (
        <div className="absolute top-14 left-3 px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400 z-10">
          Loading entities...
        </div>
      )}

      {!isLoading && (
        <div className="absolute top-14 left-3 px-3 py-1.5 bg-zinc-800/90 rounded text-xs text-zinc-400 z-10">
          {entityCount} entities
        </div>
      )}

      {selectedId && selectedEntity && (
        <EntityPanel
          entity={selectedEntity}
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
