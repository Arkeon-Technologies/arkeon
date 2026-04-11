// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { createArkeClient } from '@/lib/arke-client'
import { NetworkGraph } from '@/components/NetworkGraph'
import { ActivityFeed } from '@/components/ActivityFeed'

// Read the API key from the URL once at startup, then strip it from the
// browser URL so it doesn't leak into history, server logs, referers, or
// shared bookmarks. The key lives only in memory after this.
function readAndStripApiKey(): string | undefined {
  if (typeof window === 'undefined') return undefined
  const params = new URLSearchParams(window.location.search)
  const key = params.get('key') || undefined
  if (key) {
    params.delete('key')
    const qs = params.toString()
    const newUrl = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash
    window.history.replaceState({}, '', newUrl)
  }
  return key
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
  const entityParam = searchParams.get('entity') || undefined
  const entitiesParam = searchParams.get('entities') || undefined
  const selectParam = searchParams.get('select') || undefined
  const modeParam = searchParams.get('mode') || 'graph'

  const [mode, setMode] = useState<'graph' | 'feed'>(modeParam === 'feed' ? 'feed' : 'graph')

  const initialSeedIds = useMemo(() => {
    if (entitiesParam) return entitiesParam.split(',').filter(Boolean)
    if (entityParam) return [entityParam]
    if (selectParam) return [selectParam]
    return undefined
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [seedEntityId, setSeedEntityId] = useState(initialSeedIds?.[0] || selectParam || '')
  const [seedEntityIds, setSeedEntityIds] = useState(initialSeedIds)

  const client = useMemo(
    () => createArkeClient(apiKey),
    [apiKey]
  )

  const handleEntitySelect = useCallback((entityId: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('select', entityId)
    window.history.pushState({}, '', url.toString())
  }, [])

  const handleFeedEntityClick = useCallback((entityId: string) => {
    setSeedEntityId(entityId)
    setSeedEntityIds([entityId])
    setMode('graph')
    const url = new URL(window.location.href)
    url.searchParams.set('select', entityId)
    url.searchParams.set('mode', 'graph')
    window.history.pushState({}, '', url.toString())
  }, [])

  const switchMode = useCallback((newMode: 'graph' | 'feed') => {
    setMode(newMode)
    const url = new URL(window.location.href)
    url.searchParams.set('mode', newMode)
    window.history.pushState({}, '', url.toString())
  }, [])

  if (!apiKey && !seedEntityId) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0a]">
        <div className="max-w-md p-6 bg-zinc-900 border border-zinc-800 rounded-lg">
          <h2 className="text-lg font-semibold text-zinc-100 mb-3">Arkeon Explorer</h2>
          <p className="text-sm text-zinc-400 mb-4">
            Provide an API key and entity ID to explore the knowledge graph.
          </p>
          <div className="text-xs text-zinc-500 font-mono space-y-1">
            <p>?key=uk_xxx&entity=ENTITY_ID</p>
            <p>?key=uk_xxx&entities=ID1,ID2,ID3</p>
            <p>?key=uk_xxx&mode=feed</p>
          </div>
        </div>
      </div>
    )
  }

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

  if (!seedEntityId) {
    return (
      <div className="flex items-center justify-center h-screen bg-[#0a0a0a]">
        {navBar}
        <div className="max-w-md p-6 bg-zinc-900 border border-zinc-800 rounded-lg">
          <h2 className="text-lg font-semibold text-zinc-100 mb-3">No entity specified</h2>
          <p className="text-sm text-zinc-400">
            Graph mode requires an entity or entities parameter to seed the visualization.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen bg-[#0a0a0a] relative">
      {navBar}
      <NetworkGraph
        client={client}
        seedEntityId={seedEntityId}
        seedEntityIds={seedEntityIds}
        onEntitySelect={handleEntitySelect}
      />
    </div>
  )
}
