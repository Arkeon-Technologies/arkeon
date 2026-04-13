// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type ArkeInstanceClient } from '@/lib/arke-client'
import { type LoadedEntity, type ArkeEntity, createLoadedEntity } from '@/lib/arke-types'
import { RequestPool } from '@/lib/request-pool'

const POLL_INTERVAL = 3_000
const CACHE_DB_NAME = 'arkeon-explorer'
const CACHE_STORE = 'graph-cache'
const CACHE_KEY = 'map-state-v6'

// ---------------------------------------------------------------------------
// IndexedDB cache helpers
// ---------------------------------------------------------------------------
interface CachedState {
  entities: Array<[string, LoadedEntity]>
  fetchedRels: string[]
  lastActivityTs: string
  savedAt: number
}

function openCacheDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function loadCache(): Promise<CachedState | null> {
  try {
    const db = await openCacheDb()
    return new Promise((resolve) => {
      const tx = db.transaction(CACHE_STORE, 'readonly')
      const store = tx.objectStore(CACHE_STORE)
      const req = store.get(CACHE_KEY)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

async function saveCache(state: CachedState): Promise<void> {
  try {
    const db = await openCacheDb()
    const tx = db.transaction(CACHE_STORE, 'readwrite')
    const store = tx.objectStore(CACHE_STORE)
    store.put(state, CACHE_KEY)
  } catch {
    // Cache save is best-effort
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export interface UseMapDataResult {
  entities: Map<string, LoadedEntity>
  isLoading: boolean
  /** True once the full initial bulk load has finished (all pages fetched) */
  bulkLoadComplete: boolean
  entityCount: number
  spawningIds: Set<string>
  fetchRelationships: (id: string) => Promise<void>
  ensureEntity: (id: string) => Promise<void>
  resetView: () => void
}

export function useMapData(
  client: ArkeInstanceClient,
  nodeCap: number,
  selectId?: string,
): UseMapDataResult {
  const entitiesRef = useRef<Map<string, LoadedEntity>>(new Map())
  const [renderCount, setRenderCount] = useState(0)
  const rerender = useCallback(() => setRenderCount((n) => n + 1), [])

  const [isLoading, setIsLoading] = useState(true)
  const [bulkLoadComplete, setBulkLoadComplete] = useState(false)
  const [entityCount, setEntityCount] = useState(0)
  const [spawningIds, setSpawningIds] = useState<Set<string>>(new Set())

  const lastActivityTsRef = useRef<string>('')
  const fetchedRelsRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)

  const poolRef = useRef<RequestPool | null>(null)
  if (poolRef.current === null) poolRef.current = new RequestPool(8)

  // Debounced cache save — don't write on every single entity add
  const saveCacheTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleCacheSave = useCallback(() => {
    if (saveCacheTimerRef.current) clearTimeout(saveCacheTimerRef.current)
    saveCacheTimerRef.current = setTimeout(() => {
      const state: CachedState = {
        entities: Array.from(entitiesRef.current.entries()),
        fetchedRels: Array.from(fetchedRelsRef.current),
        lastActivityTs: lastActivityTsRef.current,
        savedAt: Date.now(),
      }
      saveCache(state)
    }, 2000)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const addEntity = useCallback((entity: ArkeEntity, relationships: LoadedEntity['relationships'] = []) => {
    if (entitiesRef.current.has(entity.id)) return false
    if (entity.kind === 'relationship') return false
    const loaded = createLoadedEntity(entity, relationships)
    entitiesRef.current.set(entity.id, loaded)
    setEntityCount(entitiesRef.current.size)
    return true
  }, [])

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
      fetchedRelsRef.current.delete(id)
    }
  }, [client, rerender])

  const fetchRelsBatch = useCallback(async (ids: string[]) => {
    const toFetch = ids.filter(id => !fetchedRelsRef.current.has(id))
    if (toFetch.length === 0) return
    await Promise.all(toFetch.map(id => fetchRelationships(id, true)))
    if (mountedRef.current) rerender()
  }, [fetchRelationships, rerender])

  const ensureEntity = useCallback(async (id: string) => {
    if (entitiesRef.current.has(id)) return
    try {
      const [entity, rels] = await poolRef.current!.execute(
        () => Promise.all([client.getEntity(id), client.getRelationships(id)]),
        `ensure:${id}`
      )
      if (!mountedRef.current) return
      if (entity.kind === 'relationship') return
      const loaded = createLoadedEntity(entity, rels.relationships, rels.outCursor, rels.inCursor)
      entitiesRef.current.set(entity.id, loaded)
      fetchedRelsRef.current.add(entity.id)
      setEntityCount(entitiesRef.current.size)
      rerender()
    } catch (err) {
      console.error(`Failed to ensure entity ${id}:`, err)
    }
  }, [client, rerender])

  // Initial load: restore from cache or fetch from API
  const initialLoadDone = useRef(false)
  useEffect(() => {
    if (initialLoadDone.current) return
    initialLoadDone.current = true

    async function load() {
      setIsLoading(true)

      // 1. Try to restore from cache
      const cached = await loadCache()
      if (cached && cached.lastActivityTs && cached.entities.length > 0) {
        // Cache is valid — hydrate instantly
        for (const [id, entity] of cached.entities) {
          entitiesRef.current.set(id, entity)
        }
        for (const id of cached.fetchedRels) {
          fetchedRelsRef.current.add(id)
        }
        lastActivityTsRef.current = cached.lastActivityTs
        setEntityCount(entitiesRef.current.size)
        setBulkLoadComplete(true)
        setIsLoading(false)
        rerender()

        // Fetch any updates since cache was saved (polling will handle the rest)
        return
      }

      // 2. No cache — fetch selected entity first if provided
      if (selectId) {
        try {
          const [entity, rels] = await Promise.all([
            client.getEntity(selectId),
            client.getRelationships(selectId),
          ])
          if (!mountedRef.current) return
          if (entity.kind !== 'relationship') {
            const loaded = createLoadedEntity(entity, rels.relationships, rels.outCursor, rels.inCursor)
            entitiesRef.current.set(entity.id, loaded)
            fetchedRelsRef.current.add(entity.id)
            setEntityCount(1)
            setIsLoading(false)
            rerender()
          }
        } catch {
          // Selected entity may not exist — continue with bulk load
        }
      }

      // 3. Progressive bulk load
      const startTs = new Date().toISOString()

      try {
        let cursor: string | null = null
        let totalLoaded = entitiesRef.current.size

        do {
          const result = await client.listEntities({
            limit: 200,
            cursor: cursor ?? undefined,
          })
          if (!mountedRef.current) return

          const batchIds: string[] = []
          for (const entity of result.entities) {
            if (totalLoaded >= nodeCap) break
            if (addEntity(entity)) {
              batchIds.push(entity.id)
              totalLoaded++
            }
          }

          if (batchIds.length > 0) {
            await fetchRelsBatch(batchIds)
          }

          if (mountedRef.current) {
            setIsLoading(false)
            rerender()
          }

          cursor = result.cursor
        } while (cursor && totalLoaded < nodeCap && mountedRef.current)

        lastActivityTsRef.current = startTs
        setBulkLoadComplete(true)
        scheduleCacheSave()
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
  }, [client, nodeCap, selectId, addEntity, rerender, fetchRelsBatch, scheduleCacheSave])

  // Polling for new entities
  useEffect(() => {
    if (isLoading) return

    const interval = setInterval(async () => {
      if (!mountedRef.current || !lastActivityTsRef.current) return

      try {
        const result = await client.getActivitySince(lastActivityTsRef.current)
        if (!mountedRef.current || result.activity.length === 0) return

        const latestTs = result.activity[0]?.ts
        if (latestTs) lastActivityTsRef.current = latestTs

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
            const loaded = createLoadedEntity(entity, rels.relationships, rels.outCursor, rels.inCursor)
            entitiesRef.current.set(entity.id, loaded)
            fetchedRelsRef.current.add(entity.id)
            setEntityCount(entitiesRef.current.size)
            newEntityIds.push(entity.id)
          }
        }

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
          setSpawningIds((prev) => {
            const next = new Set(prev)
            for (const id of newEntityIds) next.add(id)
            return next
          })
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

        // Save cache after new data arrives
        if (newEntityIds.length > 0 || relUpdates.length > 0) {
          scheduleCacheSave()
        }
      } catch (err) {
        console.error('Map polling error:', err)
      }
    }, POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [isLoading, client, nodeCap, rerender, fetchRelationships, scheduleCacheSave])

  const resetView = useCallback(async () => {
    entitiesRef.current.clear()
    fetchedRelsRef.current.clear()
    lastActivityTsRef.current = ''
    setEntityCount(0)
    setBulkLoadComplete(false)
    setIsLoading(true)
    initialLoadDone.current = false
    // Clear cache so reset actually re-fetches
    try {
      const db = await openCacheDb()
      const tx = db.transaction(CACHE_STORE, 'readwrite')
      tx.objectStore(CACHE_STORE).delete(CACHE_KEY)
    } catch {}
    rerender()
    setTimeout(() => {
      if (mountedRef.current) setRenderCount((n) => n + 1)
    }, 0)
  }, [rerender])

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
    bulkLoadComplete,
    entityCount,
    spawningIds,
    fetchRelationships,
    ensureEntity,
    resetView,
  }
}
