// Copyright (c) 2026 Arkeon Technologies, Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from 'react'
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react'
import { type LoadedEntity } from '@/lib/arke-types'
import { getTypeColor } from '@/lib/type-colors'

export interface GraphNodeData extends Record<string, unknown> {
  entity: LoadedEntity
  isSelected?: boolean
  isNeighbor?: boolean
  hasSelection?: boolean
  isSpawning?: boolean
  unloadedCount?: number
  colorMode?: 'type' | 'space'
  spaceColor?: string
}

// Inject pulse keyframes once at module load — no per-mount useEffect needed.
const PULSE_KEYFRAMES_ID = 'graph-node-pulse-keyframes'
if (typeof document !== 'undefined' && !document.getElementById(PULSE_KEYFRAMES_ID)) {
  const style = document.createElement('style')
  style.id = PULSE_KEYFRAMES_ID
  style.textContent = `
    @keyframes graph-node-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
      50% { box-shadow: 0 0 20px 8px rgba(99, 102, 241, 0.2); }
    }
    @keyframes graph-node-twinkle {
      0%, 100% { opacity: 0.7; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.15); }
    }
    @keyframes graph-node-spawn {
      0% { opacity: 0; transform: scale(0.3); }
      30% { opacity: 1; transform: scale(1.4); }
      60% { transform: scale(0.95); }
      100% { opacity: 1; transform: scale(1); }
    }
    @keyframes graph-node-spawn-glow {
      0% { box-shadow: 0 0 30px 15px rgba(255, 255, 255, 0.6); }
      100% { box-shadow: none; }
    }
  `
  document.head.appendChild(style)
}

// Deterministic delay from entity ID so animation doesn't restart on re-render
function idToDelay(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash)
  return `${(Math.abs(hash) % 3000) / 1000}s`
}

function DotView({ color, isSelected, isSpawning, entityId }: { color: string; isSelected?: boolean; isSpawning?: boolean; entityId: string }) {
  const size = isSelected ? 36 : 24
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
        border: isSelected ? '3px solid white' : 'none',
        boxShadow: isSelected
          ? `0 0 24px 8px ${color}88, 0 0 48px 16px ${color}44`
          : isSpawning
          ? `0 0 24px 10px rgba(255, 255, 255, 0.5), 0 0 40px 20px ${color}66`
          : `0 0 10px 4px ${color}66`,
        animation: isSpawning
          ? 'graph-node-spawn 0.6s ease-out forwards, graph-node-spawn-glow 2s ease-out forwards'
          : isSelected ? 'none' : 'graph-node-twinkle 3s ease-in-out infinite',
        animationDelay: isSelected ? undefined : isSpawning ? undefined : idToDelay(entityId),
        transition: 'width 0.15s, height 0.15s',
      }}
    />
  )
}

function CardView({
  entity,
  color,
  isSelected,
  isSpawning,
  unloadedCount,
}: {
  entity: LoadedEntity
  color: string
  isSelected?: boolean
  isSpawning?: boolean
  unloadedCount?: number
}) {
  const label = entity.label || entity.entity.id.slice(0, 12)
  const description = entity.description

  return (
    <div
      className="relative rounded-lg border bg-zinc-900 text-white"
      style={{
        width: 200,
        padding: '10px 12px',
        borderColor: isSelected ? color : 'rgba(63, 63, 70, 0.6)',
        borderWidth: isSelected ? 2 : 1,
        boxShadow: isSelected
          ? `0 0 20px 4px ${color}44, 0 0 40px 8px ${color}22`
          : isSpawning
          ? `0 0 16px 4px rgba(255, 255, 255, 0.3), 0 0 30px 8px ${color}44`
          : 'none',
        animation: isSpawning ? 'graph-node-spawn 0.6s ease-out forwards' : undefined,
      }}
    >
      {unloadedCount != null && unloadedCount > 0 && (
        <div
          className="absolute -top-2 -right-2 flex items-center justify-center rounded-full bg-blue-500 text-white text-[10px] font-bold"
          style={{ width: 20, height: 20 }}
        >
          +{unloadedCount > 99 ? '99' : unloadedCount}
        </div>
      )}
      <div
        className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide mb-1"
        style={{ backgroundColor: color + '33', color }}
      >
        {entity.entity.type}
      </div>
      <div className="text-sm font-medium truncate">{label}</div>
      {description && (
        <div
          className="text-xs text-zinc-400 mt-0.5"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {description}
        </div>
      )}
    </div>
  )
}

function GraphNodeInner({ data }: NodeProps) {
  const nodeData = data as unknown as GraphNodeData
  const { entity, isSelected, isSpawning, unloadedCount, colorMode, spaceColor } = nodeData
  const zoom = useStore((s) => s.transform[2])
  const color = colorMode === 'space' && spaceColor ? spaceColor : getTypeColor(entity.entity.type)

  const handleStyle = { opacity: 0, pointerEvents: 'none' as const, width: 6, height: 6 }

  return (
    <div>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="target" position={Position.Left} style={handleStyle} />

      {zoom < 0.35 ? (
        <DotView color={color} isSelected={isSelected} isSpawning={isSpawning} entityId={entity.entity.id} />
      ) : (
        <CardView
          entity={entity}
          color={color}
          isSelected={isSelected}
          isSpawning={isSpawning}
          unloadedCount={unloadedCount}
        />
      )}

      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  )
}

export const GraphNode = memo(GraphNodeInner)
