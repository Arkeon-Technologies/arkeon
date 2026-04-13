// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type ArkeInstanceClient } from '@/lib/arke-client'
import { type LoadedEntity, type ArkeEntity, createLoadedEntity } from '@/lib/arke-types'
import { RequestPool } from '@/lib/request-pool'

const POLL_INTERVAL = 3_000

export interface UseMapDataResult {
  entities: Map<string, LoadedEntity>
  isLoading: boolean
  capReached: boolean
  entityCount: number
  spawningIds: Set<string>
  fetchRelationships: (id: string) => Promise<void>
  resetView: () => void
}

export function useMapData(
  client: ArkeInstanceClient,
  nodeCap: number,
): UseMapDataResult {
  const entitiesRef = useRef<Map<string, LoadedEntity>>(new Map())
  const [renderCount, setRenderCount] = useState(0)
  const rerender = useCallback(() => setRenderCount((n) => n + 1), [])

  const [isLoading, setIsLoading] = useState(true)
  const [capReached, setCapReached] = useState(false)
  const [entityCount, setEntityCount] = useState(0)
  const [spawningIds, setSpawningIds] = useState<Set<string>>(new Set())

  const lastActivityTsRef = useRef<string>('')
  const fetchedRelsRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)

  const poolRef = useRef<RequestPool | null>(null)
  if (poolRef.current === null) poolRef.current = new RequestPool(8)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const addEntity = useCallback((entity: ArkeEntity, relationships: LoadedEntity['relationships'] = []) => {
    if (entitiesRef.current.has(entity.id)) return false
    if (entity.kind === 'relationship') return false // Skip relationship entities as nodes
    if (entitiesRef.current.size >= nodeCap) {
      setCapReached(true)
      return false
    }
    const loaded = createLoadedEntity(entity, relationships)
    entitiesRef.current.set(entity.id, loaded)
    setEntityCount(entitiesRef.current.size)
    return true
  }, [nodeCap])

  const fetchRelationships = useCallback(async (id: string, silent = false) => {
    if (fetchedRelsRef.current.has(id)) return
    fetchedRelsRef.current.add(id)

    try {
      const result = await poolRef.current!.execute(
        () => client.getRelationships(id),
        `rels:${id}`
      )
      if (!mountedRef.current) return

      const existing = entitiesRef.current.get(id)
      if (existing) {
        const updated: LoadedEntity = {
          ...existing,
          relationships: result.relationships,
          outCursor: result.outCursor,
          inCursor: result.inCursor,
          hasMore: result.hasMore,
        }
        entitiesRef.current.set(id, updated)
        if (!silent) rerender()
      }
    } catch (err) {
      console.error(`Failed to fetch relationships for ${id}:`, err)
      fetchedRelsRef.current.delete(id) // Allow retry
    }
  }, [client, rerender])

  // Fetch relationships for a batch of entity IDs.
  // Uses parallel fetching via the pool, suppresses per-entity rerenders.
  const fetchRelsBatch = useCallback(async (ids: string[]) => {
    const toFetch = ids.filter(id => !fetchedRelsRef.current.has(id))
    if (toFetch.length === 0) return

    // Fetch all in parallel (pool limits concurrency to 8)
    await Promise.all(toFetch.map(id => fetchRelationships(id, true)))

    // Single rerender after all relationships are loaded
    if (mountedRef.current) rerender()
  }, [fetchRelationships, rerender])

  // Initial bulk load
  const initialLoadDone = useRef(false)
  useEffect(() => {
    if (initialLoadDone.current) return
    initialLoadDone.current = true

    async function load() {
      setIsLoading(true)
      const startTs = new Date().toISOString()

      try {
        let cursor: string | null = null
        let totalLoaded = 0

        // Paginate through entities until cap or no more pages
        do {
          const result = await client.listEntities({
            limit: 200,
            cursor: cursor ?? undefined,
          })
          if (!mountedRef.current) return

          for (const entity of result.entities) {
            if (totalLoaded >= nodeCap) {
              setCapReached(true)
              break
            }
            if (addEntity(entity)) {
              totalLoaded++
            }
          }

          cursor = result.cursor
        } while (cursor && totalLoaded < nodeCap && mountedRef.current)

        lastActivityTsRef.current = startTs

        // Fetch relationships for all loaded entities BEFORE first render
        // so the layout has full topology info and places connected nodes together.
        const ids = Array.from(entitiesRef.current.keys())
        await fetchRelsBatch(ids)
      } catch (err) {
        console.error('Map initial load failed:', err)
      } finally {
        if (mountedRef.current) {
          setIsLoading(false)
          rerender()
        }
      }
    }
    load()
  }, [client, nodeCap, addEntity, rerender, fetchRelsBatch])

  // Polling for new entities
  useEffect(() => {
    if (isLoading) return // Don't poll during initial load

    const interval = setInterval(async () => {
      if (!mountedRef.current || !lastActivityTsRef.current) return
      if (capReached) return

      try {
        const result = await client.getActivitySince(lastActivityTsRef.current)
        if (!mountedRef.current || result.activity.length === 0) return

        // Update timestamp to latest activity
        const latestTs = result.activity[0]?.ts
        if (latestTs) lastActivityTsRef.current = latestTs

        // Collect new entity IDs and relationship updates from the activity batch
        const newEntityCandidates = new Set<string>()
        const relUpdates: Array<{ sourceId: string; targetId: string }> = []

        for (const item of result.activity) {
          if (item.action === 'entity_created' || item.action === 'content_uploaded') {
            if (!entitiesRef.current.has(item.entity_id)) {
              newEntityCandidates.add(item.entity_id)
            }
          }
          if (item.action === 'relationship_created') {
            const detail = item.detail as { target_id?: string } | null
            if (detail?.target_id) {
              relUpdates.push({ sourceId: item.entity_id, targetId: detail.target_id })
            }
          }
        }

        // Fetch all new entities + their relationships in parallel
        const newEntityIds: string[] = []
        if (newEntityCandidates.size > 0) {
          const fetches = Array.from(newEntityCandidates).map(async (id) => {
            try {
              return await poolRef.current!.execute(
                () => Promise.all([client.getEntity(id), client.getRelationships(id)]),
                `entity+rels:${id}`
              )
            } catch { return null }
          })
          const results = await Promise.all(fetches)
          for (const pair of results) {
            if (!pair || !mountedRef.current) continue
            const [entity, rels] = pair
            if (entity.kind === 'relationship') continue
            if (entitiesRef.current.size >= nodeCap) { setCapReached(true); break }
            const loaded = createLoadedEntity(entity, rels.relationships, rels.outCursor, rels.inCursor)
            entitiesRef.current.set(entity.id, loaded)
            fetchedRelsRef.current.add(entity.id)
            setEntityCount(entitiesRef.current.size)
            newEntityIds.push(entity.id)
          }
        }

        // Handle new relationships — re-fetch rels for affected loaded entities
        for (const { sourceId, targetId } of relUpdates) {
          if (entitiesRef.current.has(sourceId)) {
            fetchedRelsRef.current.delete(sourceId)
            fetchRelationships(sourceId)
          }
          if (entitiesRef.current.has(targetId)) {
            fetchedRelsRef.current.delete(targetId)
            fetchRelationships(targetId)
          }
        }

        if (newEntityIds.length > 0) {
          // Mark new entities as spawning for animation
          setSpawningIds((prev) => {
            const next = new Set(prev)
            for (const id of newEntityIds) next.add(id)
            return next
          })
          // Clear spawning after animation duration
          setTimeout(() => {
            if (!mountedRef.current) return
            setSpawningIds((prev) => {
              const next = new Set(prev)
              for (const id of newEntityIds) next.delete(id)
              return next
            })
          }, 3000)

          rerender()
        }
      } catch (err) {
        console.error('Map polling error:', err)
      }
    }, POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [isLoading, capReached, client, nodeCap, rerender, fetchRelationships])

  const resetView = useCallback(() => {
    entitiesRef.current.clear()
    fetchedRelsRef.current.clear()
    lastActivityTsRef.current = ''
    setCapReached(false)
    setEntityCount(0)
    setIsLoading(true)
    initialLoadDone.current = false
    rerender()
    // Re-trigger initial load by forcing a state change
    // The useEffect will re-run because initialLoadDone.current is false
    setTimeout(() => {
      if (mountedRef.current) {
        // Trigger re-mount of the effect
        setRenderCount((n) => n + 1)
      }
    }, 0)
  }, [rerender])

  // Build stable snapshot for consumers (same pattern as NetworkGraph)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const snapshot = useMemo(() => {
    const map = new Map<string, LoadedEntity>()
    for (const [id, entity] of entitiesRef.current) {
      if (entity.entity.kind !== 'relationship') {
        map.set(id, entity)
      }
    }
    return map
  }, [renderCount])

  return {
    entities: snapshot,
    isLoading,
    capReached,
    entityCount,
    spawningIds,
    fetchRelationships,
    resetView,
  }
}
