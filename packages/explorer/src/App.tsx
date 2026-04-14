// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { createArkeClient } from '@/lib/arke-client'
import { createMockClient } from '@/lib/mock-client'
import { ActivityFeed } from '@/components/ActivityFeed'
import { MapView } from '@/components/MapView'

// Read the API key from the URL, persist in sessionStorage so it survives
// reloads, then strip it from the browser URL so it doesn't leak into
// history, server logs, referers, or shared bookmarks.
function readAndStripApiKey(): string | undefined {
  if (typeof window === 'undefined') return undefined

  // 1. Server-injected key (auto-auth for local/deployed instances)
  const injected = (window as Record<string, unknown>).__ARKEON_KEY__ as string | undefined
  if (injected) return injected

  // 2. Explicit URL param (manual override)
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
  // 3. Fall back to sessionStorage from a previous load in this tab
  try { return sessionStorage.getItem('arke-api-key') || undefined } catch {}
  return undefined
}

function useQueryParams() {
  const [params, setParams] = useState(() => new URLSearchParams(window.location.search))
  useEffect(() => {
    const handler = () => setParams(new URLSearchParams(window.location.search))
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [])
  return params
}

export function App() {
  // Capture the API key once on mount and strip it from the URL.
  // useRef ensures it survives re-renders without being re-read from the (now-stripped) URL.
  const apiKeyRef = useRef<string | undefined>(undefined)
  if (apiKeyRef.current === undefined) {
    apiKeyRef.current = readAndStripApiKey() ?? ''
  }
  const apiKey = apiKeyRef.current || undefined

  const searchParams = useQueryParams()
  const selectParam = searchParams.get('select') || undefined
  const modeParam = searchParams.get('mode') || 'graph'
  const capParam = searchParams.get('cap')
  const nodeCap = capParam ? Math.max(1, parseInt(capParam, 10) || 3000) : 3000

  type Mode = 'graph' | 'feed'
  const initialMode: Mode = modeParam === 'feed' ? 'feed' : 'graph'
  const [mode, setMode] = useState<Mode>(initialMode)

  const useMock = searchParams.has('mock')
  const client = useMemo(
    () => useMock ? createMockClient() : createArkeClient(apiKey),
    [apiKey, useMock]
  )

  const handleEntitySelect = useCallback((entityId: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('select', entityId)
    window.history.pushState({}, '', url.toString())
  }, [])

  const handleFeedEntityClick = useCallback((entityId: string) => {
    setMode('graph')
    const url = new URL(window.location.href)
    url.searchParams.set('select', entityId)
    url.searchParams.set('mode', 'graph')
    window.history.pushState({}, '', url.toString())
  }, [])

  const switchMode = useCallback((newMode: Mode) => {
    setMode(newMode)
    const url = new URL(window.location.href)
    url.searchParams.set('mode', newMode)
    window.history.pushState({}, '', url.toString())
  }, [])

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

  if (mode === 'feed') {
    return (
      <div className="h-screen bg-[#0a0a0a] flex flex-col">
        {navBar}
        <div className="flex-1 overflow-auto pt-12 p-6 max-w-3xl mx-auto w-full">
          <ActivityFeed client={client} onSelectEntity={handleFeedEntityClick} />
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen bg-[#0a0a0a] relative">
      {navBar}
      <MapView
        client={client}
        nodeCap={nodeCap}
        selectId={selectParam}
        onEntitySelect={handleEntitySelect}
      />
    </div>
  )
}
