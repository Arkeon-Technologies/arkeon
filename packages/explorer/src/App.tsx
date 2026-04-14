// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { createArkeClient } from '@/lib/arke-client'
import { createMockClient } from '@/lib/mock-client'
import { ActivityFeed } from '@/components/ActivityFeed'
import { MapView } from '@/components/MapView'

function readAndStripApiKey(): string | undefined {
  if (typeof window === 'undefined') return undefined

  const injected = (window as Record<string, unknown>).__ARKEON_KEY__ as string | undefined
  if (injected) return injected

  const params = new URLSearchParams(window.location.search)
  const key = params.get('key') || undefined
  if (key) {
    try { sessionStorage.setItem('arke-api-key', key) } catch {}
    params.delete('key')
    const qs = params.toString()
    const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
    window.history.replaceState({}, '', newUrl)
    return key
  }
  try { return sessionStorage.getItem('arke-api-key') || undefined } catch {}
  return undefined
}

function getInitialParams() {
  const params = new URLSearchParams(window.location.search)
  return {
    select: params.get('select') || undefined,
    mode: (params.get('mode') === 'feed' ? 'feed' : 'graph') as 'graph' | 'feed',
    cap: params.get('cap'),
    mock: params.has('mock'),
  }
}

export function App() {
  const apiKeyRef = useRef<string | undefined>(undefined)
  if (apiKeyRef.current === undefined) {
    apiKeyRef.current = readAndStripApiKey() ?? ''
  }
  const apiKey = apiKeyRef.current || undefined

  const initial = useMemo(getInitialParams, [])
  const nodeCap = initial.cap ? Math.max(1, parseInt(initial.cap, 10) || 50000) : 50000

  type Mode = 'graph' | 'feed'
  const [mode, setMode] = useState<Mode>(initial.mode)
  const [selectId, setSelectId] = useState<string | undefined>(initial.select)

  const client = useMemo(
    () => initial.mock ? createMockClient() : createArkeClient(apiKey),
    [apiKey, initial.mock]
  )

  // Sync URL on popstate (back/forward)
  useEffect(() => {
    const handler = () => {
      const params = new URLSearchParams(window.location.search)
      setSelectId(params.get('select') || undefined)
      setMode(params.get('mode') === 'feed' ? 'feed' : 'graph')
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])

  const updateUrl = useCallback((updates: Record<string, string | null>) => {
    const url = new URL(window.location.href)
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) url.searchParams.delete(k)
      else url.searchParams.set(k, v)
    }
    window.history.pushState({}, '', url.toString())
  }, [])

  const handleEntitySelect = useCallback((entityId: string) => {
    setSelectId(entityId)
    updateUrl({ select: entityId })
  }, [updateUrl])

  const handleEntityDeselect = useCallback(() => {
    setSelectId(undefined)
    updateUrl({ select: null })
  }, [updateUrl])

  const handleFeedEntityClick = useCallback((entityId: string) => {
    setSelectId(entityId)
    setMode('graph')
    updateUrl({ select: entityId, mode: 'graph' })
  }, [updateUrl])

  const switchMode = useCallback((newMode: Mode) => {
    setMode(newMode)
    updateUrl({ mode: newMode })
  }, [updateUrl])

  const navBar = (
    <div className="absolute top-0 left-0 right-0 z-50 flex items-center gap-1 px-3 py-2 bg-[#0a0a0a]/80 backdrop-blur-sm border-b border-zinc-800/50">
      <span className="text-xs font-semibold text-zinc-600 mr-3 select-none">Arkeon</span>
      <button
        onClick={() => switchMode('graph')}
        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
          mode === 'graph' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        Graph
      </button>
      <button
        onClick={() => switchMode('feed')}
        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
          mode === 'feed' ? 'bg-zinc-800 text-zinc-200' : 'text-zinc-500 hover:text-zinc-300'
        }`}
      >
        Feed
      </button>
    </div>
  )

  return (
    <div className="h-screen bg-[#0a0a0a] relative">
      {navBar}
      {/* Keep MapView mounted so graph state persists across mode switches */}
      <div className={mode === 'graph' ? 'h-full' : 'hidden'}>
        <MapView
          client={client}
          nodeCap={nodeCap}
          selectId={selectId}
          onEntitySelect={handleEntitySelect}
          onEntityDeselect={handleEntityDeselect}
        />
      </div>
      {mode === 'feed' && (
        <div className="flex-1 overflow-auto pt-12 p-6 max-w-3xl mx-auto w-full h-full">
          <ActivityFeed client={client} onSelectEntity={handleFeedEntityClick} />
        </div>
      )}
    </div>
  )
}
