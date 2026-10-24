/**
 * The hub tools on the Switchboard MCP server, only while the `hub_children`
 * flag is on (the registry decides when it builds a chat's tool list). A chat
 * that is not an open child gets the parent tools `start_children` and
 * `list_children`; an open child gets `own_dependencies`. Starting is
 * `HubStarter`'s; this binds it to MCP and gathers what `list_children` reports.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { HUB_MAX_TASKS_PER_BATCH, parseHubTasks } from '@shared/hub'
import { RUNTIME_MODES, type RuntimeEvent, type RuntimeMode } from '@shared/provider-events'
import { getConversationById, getLimitResume, listHubChildren, listPendingHubWakes } from '../db/database'
import type { ChatResources } from '../hub/hub-measure'
import type { HubParentContext, HubStarter } from '../hub/hub-start'
import { createMainLogger } from '../logger'
import { toolText, type McpTool } from './mcp-session'

const log = createMainLogger('mcp:hub-tools')
const execFileP = promisify(execFile)

export const START_CHILDREN_TOOL = 'start_children'
export const LIST_CHILDREN_TOOL = 'list_children'
export const OWN_DEPENDENCIES_TOOL = 'own_dependencies'

/** The hub paragraph of the MCP instructions, for a chat that has the parent tools. Kept short: every such chat pays for it. */
export const HUB_INSTRUCTIONS = [
  'start_children starts child chats: each is an agent on one task, by default in its own worktree and branch.',
  'A child cannot see this chat, so each brief must stand on its own. list_children shows their state; do not poll',
  'it in a loop. You merge their branches yourself with git. When this chat works in the main checkout, ask the user',
  'before you merge into a branch checked out there.',
].join(' ')

export interface HubMcpToolContext {
  /** The calling chat as it is now (mode, folder, agent). */
  parent(): HubParentContext
  starter: Pick<HubStarter, 'propose' | 'waitingForSlot' | 'lastTurnOf' | 'diskUseOf'>
  resources(threadId: string): ChatResources | undefined
  publish(event: RuntimeEvent): void
  gitStats?(cwd: string, base: string): Promise<GitStats | null>
}

export interface GitStats {
  ahead: number
  behind: number
  dirty: boolean
  diffstat: string
}

const MB = 1024 * 1024

export function buildHubMcpTools(ctx: HubMcpToolContext): McpTool[] {
  const stats = ctx.gitStats ?? gitStats
  return [
    {
      name: START_CHILDREN_TOOL,
      description: [
        `Start 1 to ${HUB_MAX_TASKS_PER_BATCH} child chats, each an agent working on one task, by default in its own git`,
        "worktree off this chat's current commit (or baseRef). Each child gets its brief as its first message; it cannot",
        'see this chat, so the brief must stand on its own: the goal, the files, how to check the work, and what to',
        'report. In ask and plan modes the user approves the batch on a card first; in other modes the children start',
        'at once. A child never gets more access than this chat. The tool returns at once; use list_children to follow',
        'them. You merge their branches yourself with git.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: HUB_MAX_TASKS_PER_BATCH,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A short name for the child, shown in the sidebar.' },
                brief: { type: 'string', description: "The child's first message: the whole task." },
                location: {
                  type: 'string',
                  enum: ['worktree', 'project'],
                  description: 'worktree (default): its own worktree and branch. project: this project folder, shared.',
                },
                baseRef: { type: 'string', description: "Commit or branch to start from. Default: this chat's HEAD." },
                branch: {
                  type: 'string',
                  description: 'A name for the branch; Switchboard adds a hub/ prefix and a suffix.',
                },
                agent: { type: 'string', description: 'claude, codex, opencode, ... Default: the agent of this chat.' },
                account: { type: 'string', description: 'A provider account id. Default: the account of this chat.' },
                model: { type: 'string' },
                mode: {
                  type: 'string',
                  enum: [...RUNTIME_MODES],
                  description: "At most this chat's own mode; a higher one is lowered to it.",
                },
              },
              required: ['title', 'brief'],
              additionalProperties: false,
            },
          },
        },
        required: ['tasks'],
        additionalProperties: false,
      },
      annotations: { title: 'Start child chats', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async call(args) {
        const parent = ctx.parent()
        if (parent.mode === 'plan') {
          const reason = 'Plan mode does not start child chats.'
          ctx.publish({
            type: 'tool.denied',
            threadId: parent.threadId,
            toolName: START_CHILDREN_TOOL,
            reason,
            mode: 'plan',
          })
          return toolText(`${reason} Ask the user to leave plan mode first.`, true)
        }
        const parsed = parseHubTasks(args.tasks)
        if (!parsed.ok) return toolText(parsed.message, true)
        return ctx.starter.propose(parent, parsed.tasks)
      },
    },
    {
      name: LIST_CHILDREN_TOOL,
      description:
        "List this chat's child chats: phase, agent, account, branch, ahead and behind, uncommitted changes, " +
        'diffstat, tokens and cost of the last turn, memory and CPU of its agent, disk use, and its last update.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'List child chats', readOnlyHint: true, openWorldHint: false },
      async call() {
        const parent = ctx.parent()
        const children = listHubChildren(parent.parentId)
        if (children.length === 0) return toolText('This chat has no children.')
        const lastWake = new Map(listPendingHubWakes(parent.parentId).map((w) => [w.childId, w]))
        const rows = await Promise.all(
          children.map(async (c) => {
            const worktree = getConversationById(c.childId)?.worktree_path ?? null
            // The commit the child started from: a ref like HEAD~2 would resolve in the child's own worktree.
            const git = worktree && c.baseSha ? await stats(worktree, c.baseSha) : null
            const res = ctx.resources(c.childId)
            const turn = ctx.starter.lastTurnOf(c.childId)
            const disk = ctx.starter.diskUseOf(c.childId)
            const wake = lastWake.get(c.childId)
            return {
              childId: c.childId,
              title: c.title,
              phase: ctx.starter.waitingForSlot(c.childId) ? 'waiting for a run slot' : c.phase,
              agent: getConversationById(c.childId)?.agent_type ?? null,
              account: c.providerInstanceId,
              model: c.requestedModel,
              mode: c.grantedMode,
              location: c.location,
              branch: c.branch,
              base: c.baseRef,
              worktree,
              ...(git ?? {}),
              lastTurn: turn ? { contextTokens: turn.usedTokens ?? null, knownCostUsd: turn.costUsd ?? null } : null,
              resources: res
                ? { rssMb: Math.round(res.rssBytes / MB), cpuPct: res.cpuPct, processes: res.processes }
                : null,
              diskMb: disk === undefined ? null : Math.round(disk / MB),
              limit: getLimitResume(c.childId)?.state ?? null,
              lastUpdate: wake ? { kind: wake.kind, summary: wake.summary } : null,
              conflicts: null,
            }
          }),
        )
        const own = ctx.resources(parent.parentId)
        const total = rows.reduce((n, r) => n + (r.resources?.rssMb ?? 0), 0)
        return toolText(
          JSON.stringify(
            {
              children: rows,
              resources: {
                childrenRssMb: total,
                ...(own ? { ownRssMb: Math.round(own.rssBytes / MB), ownCpuPct: own.cpuPct } : {}),
              },
            },
            null,
            2,
          ),
        )
      },
    },
  ]
}

export interface ChildHubMcpToolContext {
  threadId: string
  runtimeMode(): RuntimeMode
  starter: Pick<HubStarter, 'ownDependencies'>
}

/** The tools of an open child. */
export function buildChildHubMcpTools(ctx: ChildHubMcpToolContext): McpTool[] {
  return [
    {
      name: OWN_DEPENDENCIES_TOOL,
      description:
        "Replace this worktree's linked dependency folders (node_modules linked to the main checkout) with your own " +
        'copy. Call it before you install, remove, update or rebuild packages; a change through a link reaches the ' +
        'main checkout and every other chat, and stops this chat.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: 'Own dependencies', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async call() {
        if (ctx.runtimeMode() === 'plan') return toolText('Plan mode does not change dependency folders.', true)
        return ctx.starter.ownDependencies(ctx.threadId)
      },
    },
  ]
}

async function gitStats(cwd: string, base: string): Promise<GitStats | null> {
  const git = async (args: string[]) => (await execFileP('git', ['-C', cwd, ...args], { maxBuffer: 8 * MB })).stdout
  try {
    const [counts, status, shortstat] = await Promise.all([
      git(['rev-list', '--left-right', '--count', `${base}...HEAD`]),
      git(['status', '--porcelain']),
      git(['diff', '--shortstat', base]),
    ])
    const [behind = 0, ahead = 0] = counts.trim().split(/\s+/).map(Number)
    return { ahead, behind, dirty: status.trim() !== '', diffstat: shortstat.trim() || 'no changes' }
  } catch (err) {
    log.warn(`could not read git state of ${cwd}`, err)
    return null
  }
}
