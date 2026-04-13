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

  const fetchRelationships = useCallback(async (id: string) => {
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
        rerender()
      }
    } catch (err) {
      console.error(`Failed to fetch relationships for ${id}:`, err)
      fetchedRelsRef.current.delete(id) // Allow retry
    }
  }, [client, rerender])

  // Background relationship fetching for a batch of entity IDs
  const fetchRelsBatch = useCallback(async (ids: string[]) => {
    const toFetch = ids.filter(id => !fetchedRelsRef.current.has(id))
    // Stagger to avoid overwhelming the pool
    for (const id of toFetch) {
      if (!mountedRef.current) break
      if (entitiesRef.current.size === 0) break
      await fetchRelationships(id)
    }
  }, [fetchRelationships])

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
          rerender()
        } while (cursor && totalLoaded < nodeCap && mountedRef.current)

        lastActivityTsRef.current = startTs
      } catch (err) {
        console.error('Map initial load failed:', err)
      } finally {
        if (mountedRef.current) {
          setIsLoading(false)
          rerender()
        }
      }

      // Background: fetch relationships for all loaded entities
      const ids = Array.from(entitiesRef.current.keys())
      fetchRelsBatch(ids)
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

        // Process new entities
        const newEntityIds: string[] = []
        for (const item of result.activity) {
          if (item.action === 'entity_created' || item.action === 'content_uploaded') {
            if (!entitiesRef.current.has(item.entity_id)) {
              try {
                const entity = await poolRef.current!.execute(
                  () => client.getEntity(item.entity_id),
                  `entity:${item.entity_id}`
                )
                if (mountedRef.current && addEntity(entity)) {
                  newEntityIds.push(entity.id)
                }
              } catch {
                // Entity may have been deleted between activity and fetch
              }
            }
          }

          // Handle new relationships — update existing loaded entities
          // Activity detail has { target_id, predicate, relationship_id }
          // The source is item.entity_id (the activity's entity)
          if (item.action === 'relationship_created') {
            const detail = item.detail as { target_id?: string } | null
            const sourceId = item.entity_id
            const targetId = detail?.target_id
            if (sourceId && entitiesRef.current.has(sourceId)) {
              fetchedRelsRef.current.delete(sourceId)
              fetchRelationships(sourceId)
            }
            if (targetId && entitiesRef.current.has(targetId)) {
              fetchedRelsRef.current.delete(targetId)
              fetchRelationships(targetId)
            }
          }
        }

        if (newEntityIds.length > 0) {
          rerender()
          // Fetch relationships for new entities
          fetchRelsBatch(newEntityIds)
        }
      } catch (err) {
        console.error('Map polling error:', err)
      }
    }, POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [isLoading, capReached, client, addEntity, rerender, fetchRelationships, fetchRelsBatch])

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
    fetchRelationships,
    resetView,
  }
}
