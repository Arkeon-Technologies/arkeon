import { useEffect, useState, useCallback, useRef } from 'react'
import { type ArkeInstanceClient } from '@/lib/arke-client'
import { type ActivityItem } from '@/lib/arke-types'
import { Card, CardContent } from '@/components/ui/Card'
import { getTypeColor } from '@/lib/type-colors'

const POLL_INTERVAL = 5_000

interface ActivityFeedProps {
  client: ArkeInstanceClient
  onSelectEntity: (entityId: string) => void
}

function useActorLabels(client: ArkeInstanceClient, actorIds: string[]) {
  const [labels, setLabels] = useState<Map<string, string>>(new Map())
  const resolvedRef = useRef(new Set<string>())

  useEffect(() => {
    const toResolve = actorIds.filter(id => !resolvedRef.current.has(id))
    if (toResolve.length === 0) return

    for (const id of toResolve) {
      resolvedRef.current.add(id)
      client.getActor(id).then(actor => {
        const label = (actor.properties?.label ?? actor.properties?.name) as string | undefined
        if (label) {
          setLabels(prev => new Map(prev).set(id, label))
        }
      }).catch(() => {})
    }
  }, [client, actorIds])

  return labels
}

interface EntityInfo {
  label?: string
  type?: string
}

function useEntityInfo(client: ArkeInstanceClient, entityIds: string[]) {
  const [info, setInfo] = useState<Map<string, EntityInfo>>(new Map())
  const resolvedRef = useRef(new Set<string>())

  useEffect(() => {
    const toResolve = entityIds.filter(id => !resolvedRef.current.has(id))
    if (toResolve.length === 0) return

    for (const id of toResolve) {
      resolvedRef.current.add(id)
      client.getEntity(id).then(entity => {
        const label = (entity.properties?.label ?? entity.properties?.title ?? entity.properties?.name) as string | undefined
        setInfo(prev => new Map(prev).set(id, { label, type: entity.type }))
      }).catch(() => {})
    }
  }, [client, entityIds])

  return info
}

const ACTION_LABELS: Record<string, string> = {
  entity_created: 'Created',
  entity_updated: 'Updated',
  content_uploaded: 'Uploaded',
  relationship_added: 'Linked',
  relationship_removed: 'Unlinked',
  entity_deleted: 'Deleted',
}

function getActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ')
}

function getActionColor(action: string): string {
  switch (action) {
    case 'entity_created':
      return 'bg-green-900/30 text-green-400'
    case 'entity_updated':
      return 'bg-blue-900/30 text-blue-400'
    case 'content_uploaded':
      return 'bg-yellow-900/30 text-yellow-400'
    case 'relationship_added':
      return 'bg-purple-900/30 text-purple-400'
    case 'relationship_removed':
      return 'bg-orange-900/30 text-orange-400'
    case 'entity_deleted':
      return 'bg-red-900/30 text-red-400'
    default:
      return 'bg-zinc-800 text-zinc-400'
  }
}

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

export function ActivityFeed({ client, onSelectEntity }: ActivityFeedProps) {
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pollFailures, setPollFailures] = useState(0)

  const knownIds = useRef(new Set<string | number>())

  const actorIds = [...new Set(activity.map(a => a.actor_id))]
  const entityIds = [...new Set(activity.map(a => a.entity_id))]
  const actorLabels = useActorLabels(client, actorIds)
  const entityInfo = useEntityInfo(client, entityIds)

  useEffect(() => {
    setLoading(true)
    client.getActivity()
      .then((data) => {
        setActivity(data.activity)
        setCursor(data.cursor)
        knownIds.current = new Set(data.activity.map((a) => a.id))
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load activity'))
      .finally(() => setLoading(false))
  }, [client])

  // Poll for new activity every 5 seconds. Track repeated failures so the
  // user can see if polling has stalled (don't disrupt the feed on a single
  // transient blip, but surface a banner after several consecutive failures).
  useEffect(() => {
    const interval = setInterval(() => {
      client.getActivity().then((data) => {
        const newItems = data.activity.filter((a) => !knownIds.current.has(a.id))
        if (newItems.length > 0) {
          for (const item of newItems) knownIds.current.add(item.id)
          setActivity((prev) => [...newItems, ...prev])
        }
        setPollFailures(0)
      }).catch(() => {
        setPollFailures((n) => n + 1)
      })
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [client])

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    client.getActivity(cursor)
      .then((data) => {
        for (const item of data.activity) knownIds.current.add(item.id)
        setActivity((prev) => [...prev, ...data.activity])
        setCursor(data.cursor)
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false))
  }, [client, cursor, loadingMore])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-zinc-500">Loading activity...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-red-500">{error}</p>
      </div>
    )
  }

  if (activity.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2">
        <p className="text-zinc-500">No activity yet</p>
        <p className="text-sm text-zinc-400">Activity will appear here as entities are created and modified on your network.</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto py-6 px-6 space-y-2">
        {pollFailures >= 3 && (
          <div className="px-3 py-2 rounded bg-amber-900/30 border border-amber-800/50 text-xs text-amber-400">
            Live updates paused — {pollFailures} consecutive poll failures. Refresh to retry.
          </div>
        )}
        {activity.map((item) => {
          const info = entityInfo.get(item.entity_id)
          const typeColor = info?.type ? getTypeColor(info.type) : undefined
          return (
            <Card key={item.id}>
              <CardContent className="py-3 px-4">
                <button
                  onClick={() => onSelectEntity(item.entity_id)}
                  className="w-full flex flex-col gap-1.5 text-left hover:opacity-80 transition-opacity"
                >
                  <div className="flex items-center gap-3">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium shrink-0 ${getActionColor(item.action)}`}>
                      {getActionLabel(item.action)}
                    </span>
                    {info?.type && (
                      <span
                        className="text-[9px] font-semibold uppercase px-1 py-0.5 rounded shrink-0"
                        style={{ backgroundColor: (typeColor || '#71717a') + '33', color: typeColor }}
                      >
                        {info.type}
                      </span>
                    )}
                    <span className="text-sm text-zinc-200 truncate flex-1">
                      {info?.label || <code className="font-mono text-zinc-500">{item.entity_id}</code>}
                    </span>
                    <span className="text-xs text-zinc-500 shrink-0">
                      {relativeTime(item.ts)}
                    </span>
                  </div>
                  {(actorLabels.get(item.actor_id) || info?.label) && (
                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                      {actorLabels.get(item.actor_id) && (
                        <span>by {actorLabels.get(item.actor_id)}</span>
                      )}
                      {info?.label && (
                        <code className="font-mono text-zinc-600 text-[10px] truncate">{item.entity_id}</code>
                      )}
                    </div>
                  )}
                </button>
              </CardContent>
            </Card>
          )
        })}

        {cursor && (
          <div className="flex justify-center pt-4">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="px-4 py-2 text-sm text-zinc-400 hover:text-white border border-zinc-800 rounded-lg hover:border-zinc-700 transition-colors disabled:opacity-50"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
