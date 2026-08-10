/**
 * Codex `update_plan` payload to todo items.
 *
 * This is the model's own progress checklist, NOT a plan awaiting approval:
 * a real Codex plan proposal is the `exit_plan_mode` tool, intercepted through
 * CUSTOM_UI_TOOLS. Keeping the two apart is why this returns structured items
 * rather than the markdown the UI used to render as a plan card.
 */
import type { TodoItem, TodoStatus } from '@shared/provider-events'

const STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed'])

export function parseCodexTodoItems(params: unknown): TodoItem[] {
  const plan = (params as { plan?: unknown } | undefined)?.plan
  if (!Array.isArray(plan)) return []
  const items: TodoItem[] = []
  for (const entry of plan) {
    const obj = entry as { step?: unknown; status?: unknown } | null
    const text = typeof obj?.step === 'string' ? obj.step.trim() : ''
    if (!text) continue
    const raw = obj?.status
    const status = typeof raw === 'string' && STATUSES.has(raw as TodoStatus)
      ? (raw as TodoStatus)
      : 'pending'
    items.push({ text, status })
  }
  return items
}

/**
 * The same checklist when it arrives as markdown text rather than a plan
 * array, which is the shape of the `item/completed` notification.
 */
export function parseCodexTodoMarkdown(text: string): TodoItem[] {
  const items: TodoItem[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line)
    if (!match) continue
    const body = match[2].trim()
    if (!body) continue
    items.push({ text: body, status: match[1]?.toLowerCase() === 'x' ? 'completed' : 'pending' })
  }
  return items
}
