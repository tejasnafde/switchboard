import { agentShortLabel, type AgentType, type ChatMessage } from '@shared/types'

/**
 * Serialize a chat session to Markdown.
 *
 * Format:
 *   # {title}
 *   *Project: /path/to/project*
 *   *Started: Mon Apr 21 2026*
 *
 *   ---
 *   ## You — 14:32
 *   {user text}
 *
 *   ---
 *   ## Claude — 14:33
 *   {assistant markdown}
 *
 *   <details><summary>Bash: ls -la</summary>
 *   {tool input / output}
 *   </details>
 *
 * Handles every attachment type: toolCalls, approval, plan, question, images,
 * denial. Images embed as data URLs (for self-contained exports) unless an
 * http(s) URL was stored.
 */
export function serializeConversationToMarkdown(opts: {
  title: string
  projectPath?: string
  startedAt?: number
  messages: ChatMessage[]
  agentType?: AgentType
}): string {
  const { title, projectPath, startedAt, messages, agentType } = opts
  const lines: string[] = []

  lines.push(`# ${title}`)
  lines.push('')
  if (projectPath) lines.push(`*Project: \`${projectPath}\`*  `)
  if (startedAt) lines.push(`*Started: ${new Date(startedAt).toLocaleString()}*  `)
  lines.push(`*Exported: ${new Date().toLocaleString()}*`)
  lines.push('')
  lines.push('---')
  lines.push('')

  let lastRole: string | null = null
  for (const msg of messages) {
    // Skip truly empty messages (same filter as groupIntoTurns).
    if (
      !msg.content &&
      !msg.toolCalls?.length &&
      !msg.approval &&
      !msg.question &&
      !msg.plan &&
      !msg.images?.length &&
      !msg.denial
    ) continue

    if (msg.role !== lastRole) {
      if (lastRole !== null) {
        lines.push('')
        lines.push('---')
        lines.push('')
      }
      const label = msg.role === 'user' ? 'You'
        : msg.role === 'system' ? 'System'
        : agentShortLabel(agentType)
      const time = new Date(msg.timestamp).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit',
      })
      lines.push(`## ${label} — ${time}`)
      lines.push('')
      lastRole = msg.role
    }

    // Text content (user prose or assistant markdown)
    if (msg.content) {
      lines.push(msg.content)
      lines.push('')
    }

    // Attached images
    if (msg.images?.length) {
      for (const img of msg.images) {
        const alt = img.name ?? 'image'
        lines.push(`![${alt}](${img.url})`)
      }
      lines.push('')
    }

    // Tool calls
    if (msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) {
        const summary = summarizeToolCall(tc.name, tc.input)
        lines.push(`<details>`)
        lines.push(`<summary><strong>${escapeHtml(tc.name)}</strong>${summary ? ` — <code>${escapeHtml(summary)}</code>` : ''}</summary>`)
        lines.push('')
        lines.push('```')
        lines.push(typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2))
        lines.push('```')
        if (tc.output) {
          lines.push('')
          lines.push('**Output:**')
          lines.push('')
          lines.push('```')
          lines.push(tc.output)
          lines.push('```')
        }
        lines.push('</details>')
        lines.push('')
      }
    }

    // Approval card
    if (msg.approval) {
      lines.push(`> **Permission request** — \`${msg.approval.toolName}\` (${msg.approval.status})`)
      if (msg.approval.detail) {
        lines.push('> ```')
        for (const l of msg.approval.detail.split('\n')) lines.push(`> ${l}`)
        lines.push('> ```')
      }
      lines.push('')
    }

    // Plan card
    if (msg.plan) {
      lines.push(`### Proposed plan`)
      lines.push('')
      lines.push(msg.plan.markdown)
      lines.push('')
    }

    // Question card
    if (msg.question) {
      lines.push(`### Questions (${msg.question.status})`)
      lines.push('')
      for (const q of msg.question.questions) {
        lines.push(`**${q.header}** — ${q.question}`)
        for (const opt of q.options) {
          lines.push(`- ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`)
        }
        lines.push('')
      }
      if (msg.question.answers) {
        lines.push(`*Answers:* ${msg.question.answers.map((a) => a.join(', ')).join(' | ')}`)
        lines.push('')
      }
    }

    // Denial pill
    if (msg.denial) {
      lines.push(`> 🚫 **Blocked** — \`${msg.denial.toolName}\` (${msg.denial.mode}): ${msg.denial.reason}`)
      lines.push('')
    }
  }

  return lines.join('\n').trimEnd() + '\n'
}

function summarizeToolCall(_name: string, input: string | object): string {
  if (typeof input === 'string') {
    return input.split('\n')[0].slice(0, 80)
  }
  try {
    const parsed = typeof input === 'string' ? JSON.parse(input as string) : input
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.command === 'string') return obj.command.slice(0, 80)
      if (typeof obj.file_path === 'string') return obj.file_path
      if (typeof obj.path === 'string') return obj.path
      if (typeof obj.url === 'string') return obj.url
    }
  } catch { /* ignore */ }
  return ''
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Suggest a filename like `chat-admin-panel-changes-2026-04-21.md` */
export function suggestedExportFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
  const date = new Date().toISOString().slice(0, 10)
  return `chat-${slug || 'export'}-${date}.md`
}
