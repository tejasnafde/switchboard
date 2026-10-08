/**
 * The link tools of the Switchboard MCP server: `link_pull_request`,
 * `unlink_pull_request` and `list_thread_pull_requests`. A link changes only
 * what the PR tools may act on, nothing on a host, so there is no approval
 * card: plan mode refuses link and unlink (`decidePermission`), every other
 * mode runs them, and the list runs unasked. The repository rule is the one
 * Reviews' "Link to chat" uses: only a PR of a repository the chat's project
 * covers. An unlink leaves a tombstone, so automatic linking never brings it back.
 */
import { canLinkToProject, findPullRequestUrls, type PrLink } from '@shared/pull-request-links'
import { coveredRepos } from '@shared/project-repos'
import { parseFullName } from '@shared/pull-request-remote'
import { PR_HOST_LABEL, repoKey, type PrHost, type PrRef } from '@shared/pull-requests'
import type { RuntimeEvent, RuntimeMode } from '@shared/provider-events'
import { decidePermission, denialMessage } from '../provider/policy'
import { createMainLogger } from '../logger'
import { toolText, type McpTool, type McpToolResult } from './mcp-session'
import { pickLinkedPr, type AgentPullRequestAccess } from './pr-tools'

const log = createMainLogger('mcp:pr-link-tools')

export const PR_LINK_TOOL = 'link_pull_request'
export const PR_UNLINK_TOOL = 'unlink_pull_request'
export const PR_LIST_LINKS_TOOL = 'list_thread_pull_requests'

export type PrLinkAccess = Pick<
  AgentPullRequestAccess,
  'chatProject' | 'projectRepos' | 'linkToChat' | 'links' | 'unlinkFromChat' | 'linkProblem'
>

export interface PrLinkToolContext {
  threadId: string
  /** The chat's root id, which links are keyed by. */
  chatId: string
  runtimeMode(): RuntimeMode
  publish(event: RuntimeEvent): void
  /** Null on a backend without Reviews. */
  pullRequests: PrLinkAccess | null
}

const NO_REVIEWS = 'Reviews is not available on this backend, so pull requests cannot be linked here.'

function label(ref: PrRef): string {
  return `${PR_HOST_LABEL[ref.host]} ${ref.owner}/${ref.name} #${ref.number}`
}

function webUrl(ref: PrRef): string {
  return ref.host === 'github'
    ? `https://github.com/${ref.owner}/${ref.name}/pull/${ref.number}`
    : `https://bitbucket.org/${ref.owner}/${ref.name}/pull-requests/${ref.number}`
}

/** The PR the arguments name: a URL in `pr`, or `repository` + `number` (+ `host` when the name is on both hosts). */
function targetOf(
  args: Record<string, unknown>,
  covered: { host: PrHost; owner: string; name: string }[],
): PrRef | string {
  if (typeof args.pr === 'string') {
    const url = findPullRequestUrls(args.pr)[0]
    if (url) return url
  }
  const number = Number(args.number)
  if (typeof args.repository !== 'string' || !Number.isInteger(number) || number <= 0) {
    return 'Pass "pr" with the pull request URL, or "repository" ("owner/name") and "number".'
  }
  const host: PrHost | null = args.host === 'github' || args.host === 'bitbucket' ? args.host : null
  const named = parseFullName(host ?? 'github', args.repository)
  if (!named) return `"${args.repository}" is not an owner/name repository.`
  const key = (h: PrHost) => repoKey({ ...named, host: h })
  const hosts = host
    ? [host]
    : (['github', 'bitbucket'] as const).filter((h) => covered.some((r) => repoKey(r) === key(h)))
  if (hosts.length > 1) return `${args.repository} is on both GitHub and Bitbucket in this project. Pass "host".`
  return { ...named, host: hosts[0] ?? host ?? 'github', number }
}

export function buildPrLinkTools(ctx: PrLinkToolContext): McpTool[] {
  const refusePlan = (toolName: string): McpToolResult | null => {
    const mode = ctx.runtimeMode()
    const name = `mcp__switchboard__${toolName}`
    if (decidePermission(mode, name) !== 'deny') return null
    const reason = denialMessage(mode, name)
    ctx.publish({ type: 'tool.denied', threadId: ctx.threadId, toolName: name, reason, mode })
    return toolText(`${reason} Nothing was linked or unlinked.`, true)
  }

  const linkTool: McpTool = {
    name: PR_LINK_TOOL,
    description: [
      'Link a pull request to this chat, so the pull request tools can act on it and it shows in the chat header and Reviews.',
      'Link a pull request you opened outside create_pull_request (gh, bbpr or a host API) or one the user asks you to work on;',
      'do not link pull requests mentioned only as background. Only a pull request of a repository this project covers can be linked.',
      'Pass "pr" with its URL, or "repository" ("owner/name") and "number". Changes nothing on the host; refused in plan mode.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'string', description: 'The pull request URL.' },
        repository: { type: 'string', description: '"owner/name", with "number", instead of a URL.' },
        number: { type: 'number', description: 'The pull request number, with "repository".' },
        host: {
          type: 'string',
          enum: ['github', 'bitbucket'],
          description: 'Only when the repository name exists on both hosts.',
        },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Link a pull request', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async call(args) {
      const access = ctx.pullRequests
      if (!access) return toolText(NO_REVIEWS, true)
      const refused = refusePlan(PR_LINK_TOOL)
      if (refused) return refused
      const projectPath = access.chatProject(ctx.chatId)
      if (!projectPath) return toolText('This chat has no Switchboard record to link to.', true)
      const project = await access.projectRepos(projectPath)
      const covered = coveredRepos(project)
      const ref = targetOf(args, covered)
      if (typeof ref === 'string') return toolText(ref, true)
      if (!canLinkToProject(ref, project)) {
        const repos = covered.map((r) => `${r.owner}/${r.name}`).join(', ')
        return toolText(
          `${label(ref)} is not on a repository of this project${repos ? ` (${repos})` : ''}. Nothing was linked.`,
          true,
        )
      }
      const already = access
        .links(ctx.chatId)
        .some((l) => repoKey(l.ref) === repoKey(ref) && l.ref.number === ref.number)
      if (already) return toolText(`${label(ref)} is already linked to this chat.`)
      if (!access.linkToChat(ctx.chatId, ref, false))
        return toolText(`Linking ${label(ref)} failed; see the Switchboard log. Tell the user.`, true)
      log.info('agent linked a pull request', { host: ref.host, number: ref.number })
      return toolText(`Linked ${label(ref)} to this chat. The pull request tools can act on it now.`)
    },
  }

  const unlinkTool: McpTool = {
    name: PR_UNLINK_TOOL,
    description: [
      'Unlink a pull request from this chat, for one linked by mistake (automatic linking picks up every pull request URL of the project the chat mentions).',
      'It stays unlinked: automatic linking never links it again. Pass "pr": its number, "#612" or its URL. Refused in plan mode.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: ['string', 'number'], description: 'The linked pull request: its number, "#612" or its URL.' },
      },
      required: ['pr'],
      additionalProperties: false,
    },
    annotations: { title: 'Unlink a pull request', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async call(args) {
      const access = ctx.pullRequests
      if (!access) return toolText(NO_REVIEWS, true)
      const refused = refusePlan(PR_UNLINK_TOOL)
      if (refused) return refused
      const picked = pickLinkedPr(
        access.links(ctx.chatId).map((l) => l.ref),
        args.pr,
      )
      if (!picked.ok) return toolText(picked.message, true)
      if (!access.unlinkFromChat(ctx.chatId, picked.ref))
        return toolText(`${label(picked.ref)} was not linked to this chat.`, true)
      log.info('agent unlinked a pull request', { host: picked.ref.host, number: picked.ref.number })
      return toolText(`Unlinked ${label(picked.ref)} from this chat. It will not be linked again automatically.`)
    },
  }

  const listTool: McpTool = {
    name: PR_LIST_LINKS_TOOL,
    description: [
      "The pull requests linked to this chat: each one's URL, how it was linked (manual: the user; auto: its URL or branch",
      'appeared in the chat; agent: an agent linked it; created: an agent opened it) and its last known state.',
      'Also the last problem automatic linking hit, if any. Read-only; runs without asking. Call it before you finish work on a pull request.',
    ].join('\n'),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Linked pull requests', readOnlyHint: true, openWorldHint: false },
    async call() {
      const access = ctx.pullRequests
      if (!access) return toolText(NO_REVIEWS, true)
      const problem = access.linkProblem(ctx.chatId)
      return toolText(
        JSON.stringify(
          {
            pullRequests: access.links(ctx.chatId).map((l: PrLink) => ({
              pr: label(l.ref),
              url: webUrl(l.ref),
              linkedBy: l.source,
              ...(l.state ? { state: l.state } : {}),
            })),
            ...(problem
              ? { lastAutoLinkProblem: { at: new Date(problem.at).toISOString(), message: problem.message } }
              : {}),
          },
          null,
          2,
        ),
      )
    },
  }

  return [linkTool, unlinkTool, listTool]
}
