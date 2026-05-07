/**
 * BranchesScreen — multi-worktree merge orchestrator.
 *
 * Renders a project picker, then a `@xyflow/react` DAG of the project's
 * worktree branches. The user authors dependency edges by dragging from
 * a node's output handle to another node's input handle. Suggested
 * edges (from `overlapDetector`) render dashed and confirm to solid on
 * click. A side panel hosts the Plan / Execute / Resume controls + the
 * conflict-resolution dialog.
 *
 * Pattern matches `KanbanView`: lives at App level alongside the chat
 * layout, hydrated by `branches-store`, scoped by project. No per-
 * workspace filter (yet) — branches are inherently per-repo.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MarkerType,
  type Edge,
  type Node,
  type Connection,
  type EdgeTypes,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import { useBranchesStore } from '../../stores/branches-store'
import { useLayoutStore } from '../../stores/layout-store'
import type { Project } from '@shared/types'
import type { BranchEdgeWire, BranchNodeWire, SuggestedEdgeWire } from '@shared/branches'
import { MergePlanCard } from './MergePlanCard'
import { ConflictResolutionPanel } from './ConflictResolutionPanel'

const NODE_WIDTH = 220
const NODE_HEIGHT = 60
const COLUMN_GAP = 60
const ROW_GAP = 28

interface BranchNodeData extends Record<string, unknown> {
  branch: string
  worktreePath: string
  head: string
}

/* ──────────────────────────────────────────────────────────────────
 * Layout: longest-path columns, alphabetical row order within column.
 * Cheap and deterministic — good enough for the small graphs (<20
 * nodes) the user typically has in flight.
 * ────────────────────────────────────────────────────────────────── */
function layoutNodes(
  nodes: BranchNodeWire[],
  edges: BranchEdgeWire[],
): Node<BranchNodeData>[] {
  if (nodes.length === 0) return []
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()
  for (const n of nodes) {
    incoming.set(n.branch, new Set())
    outgoing.set(n.branch, new Set())
  }
  for (const e of edges) {
    incoming.get(e.child)?.add(e.parent)
    outgoing.get(e.parent)?.add(e.child)
  }
  // BFS column assignment (same as `parallelGroup` in mergePlan).
  const col = new Map<string, number>()
  const inDeg = new Map<string, number>()
  for (const [b, ins] of incoming) inDeg.set(b, ins.size)
  let frontier = [...inDeg.entries()].filter(([, d]) => d === 0).map(([b]) => b)
  let depth = 0
  while (frontier.length > 0) {
    const next: string[] = []
    for (const b of frontier) {
      col.set(b, depth)
      for (const c of outgoing.get(b) ?? []) {
        const d = (inDeg.get(c) ?? 0) - 1
        inDeg.set(c, d)
        if (d === 0) next.push(c)
      }
    }
    frontier = next
    depth += 1
  }
  // Cycle? Place anything left at the rightmost column.
  for (const n of nodes) if (!col.has(n.branch)) col.set(n.branch, depth)

  // Bucket by column, sort each column alphabetically, assign Y.
  const buckets = new Map<number, BranchNodeWire[]>()
  for (const n of nodes) {
    const c = col.get(n.branch) ?? 0
    if (!buckets.has(c)) buckets.set(c, [])
    buckets.get(c)!.push(n)
  }
  const out: Node<BranchNodeData>[] = []
  for (const [c, list] of buckets) {
    list.sort((a, b) => a.branch.localeCompare(b.branch))
    list.forEach((n, i) => {
      out.push({
        id: n.branch,
        position: {
          x: c * (NODE_WIDTH + COLUMN_GAP),
          y: i * (NODE_HEIGHT + ROW_GAP),
        },
        data: { branch: n.branch, worktreePath: n.worktreePath, head: n.head },
        type: 'branch',
      })
    })
  }
  return out
}

function buildEdges(
  edges: BranchEdgeWire[],
  suggested: SuggestedEdgeWire[],
): Edge[] {
  const real: Edge[] = edges.map((e) => ({
    id: `e:${e.parent}->${e.child}`,
    source: e.parent,
    target: e.child,
    type: 'smoothstep',
    animated: false,
    data: { kind: 'persisted' },
    style: { stroke: 'var(--text-muted)', strokeWidth: 1.5 },
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--text-muted)' },
  }))
  const sug: Edge[] = suggested.map((s) => ({
    id: `s:${s.parent}->${s.child}`,
    source: s.parent,
    target: s.child,
    type: 'smoothstep',
    animated: true,
    data: { kind: 'suggested' },
    style: { stroke: 'var(--accent, #5b8cff)', strokeWidth: 1, strokeDasharray: '6 4' },
    label: 'suggested',
    labelStyle: { fontSize: 10, fill: 'var(--accent, #5b8cff)' },
    markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--accent, #5b8cff)' },
  }))
  return [...real, ...sug]
}

/* ──────────────────────────────────────────────────────────────────
 * Custom node — branch label + truncated head + worktree path on
 * hover. Plain HTML, themed via CSS variables.
 * ────────────────────────────────────────────────────────────────── */
function BranchNodeView({ data }: { data: BranchNodeData }): React.ReactElement {
  return (
    <div
      style={{
        width: NODE_WIDTH,
        minHeight: NODE_HEIGHT,
        padding: '8px 12px',
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        fontSize: 12,
        color: 'var(--text-primary)',
        overflow: 'hidden',
      }}
      title={data.worktreePath}
    >
      <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {data.branch}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        {String(data.head).slice(0, 7)}
      </div>
    </div>
  )
}

const nodeTypes: NodeTypes = { branch: BranchNodeView }
const edgeTypes: EdgeTypes = {}

/* ──────────────────────────────────────────────────────────────────
 * Top-level screen
 * ────────────────────────────────────────────────────────────────── */
export function BranchesScreen(): React.ReactElement {
  return (
    <ReactFlowProvider>
      <BranchesScreenInner />
    </ReactFlowProvider>
  )
}

function BranchesScreenInner(): React.ReactElement {
  const projectFilter = useLayoutStore((s) => s.kanbanProjectFilter)
  const setProjectFilter = useLayoutStore((s) => s.setKanbanProjectFilter)
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    const promise = window.api?.app?.getProjects() as Promise<Project[]> | undefined
    if (!promise) return
    void promise.then((list) => {
      setProjects(list)
      if (!projectFilter && list.length > 0) {
        setProjectFilter(list[0].path)
      }
    }).catch(() => undefined)
  }, [])

  if (!projectFilter) {
    return (
      <div style={{ padding: 24, color: 'var(--text-muted)' }}>
        Add a project to get started.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: '1 1 0%', minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-primary)',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Project</span>
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value || null)}
          style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            color: 'var(--text-primary)',
            padding: '4px 8px',
            fontSize: 12,
            borderRadius: 4,
          }}
        >
          {projects.map((p) => (
            <option key={p.path} value={p.path}>{p.name}</option>
          ))}
        </select>
      </div>
      <BranchesGraph repoPath={projectFilter} />
    </div>
  )
}

function BranchesGraph({ repoPath }: { repoPath: string }): React.ReactElement {
  const slice = useBranchesStore((s) => s.byRepo[repoPath])
  const hydrate = useBranchesStore((s) => s.hydrate)
  const addEdge = useBranchesStore((s) => s.addEdge)
  const removeEdge = useBranchesStore((s) => s.removeEdge)
  const suggestEdges = useBranchesStore((s) => s.suggestEdges)
  const startEventBridge = useBranchesStore((s) => s.startEventBridge)

  useEffect(() => {
    void hydrate(repoPath)
    startEventBridge()
  }, [repoPath, hydrate, startEventBridge])

  // Narrow the deps so live-event updates (eventLog, running flag,
  // lastPlan) don't re-trigger the BFS layout.
  const nodes = slice?.view.nodes
  const edges = slice?.view.edges
  const suggestedEdges = slice?.view.suggestedEdges
  const flowNodes = useMemo(
    () => (nodes && edges ? layoutNodes(nodes, edges) : []),
    [nodes, edges],
  )
  const flowEdges = useMemo(
    () => (edges && suggestedEdges ? buildEdges(edges, suggestedEdges) : []),
    [edges, suggestedEdges],
  )

  const handleConnect = useCallback(
    async (conn: Connection) => {
      if (!conn.source || !conn.target) return
      if (conn.source === conn.target) return
      await addEdge({ repoPath, parent: conn.source, child: conn.target })
    },
    [addEdge, repoPath],
  )

  const handleEdgeContextMenu = useCallback(
    async (e: React.MouseEvent, edge: Edge) => {
      e.preventDefault()
      // Right-click → remove. Suggested edges aren't persisted; just
      // refresh the suggestion cache. Persisted edges go through the
      // SQLite path.
      if (edge.data?.kind === 'suggested') {
        await suggestEdges(repoPath)
        return
      }
      await removeEdge({ repoPath, parent: edge.source, child: edge.target })
    },
    [removeEdge, suggestEdges, repoPath],
  )

  if (!slice) {
    return <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>
  }

  if (slice.view.nodes.length === 0) {
    return (
      <div style={{ padding: 32, color: 'var(--text-muted)', maxWidth: 600 }}>
        <p>No worktrees in this project yet.</p>
        <p style={{ fontSize: 12 }}>
          Create a kanban card with the worktree option, or fork a conversation
          into a worktree, then come back here to author dependencies and
          orchestrate the merge.
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flex: '1 1 0%', minWidth: 0, position: 'relative' }}>
      <div style={{ flex: '1 1 0%', minWidth: 0, position: 'relative' }}>
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onConnect={handleConnect}
          onEdgeContextMenu={handleEdgeContextMenu}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <div
        style={{
          width: 360,
          flex: '0 0 360px',
          borderLeft: '1px solid var(--border)',
          background: 'var(--bg-primary)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <MergePlanCard repoPath={repoPath} />
        <ConflictResolutionPanel repoPath={repoPath} />
      </div>
    </div>
  )
}
