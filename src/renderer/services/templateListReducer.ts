/**
 * Pure reducer for the Settings → Workspaces template-list editor.
 *
 * Drives add / rename / delete / replace-body actions on a parsed
 * `WorkspaceConfig`. The Settings UI calls this on every action and
 * persists the resulting config back to disk via
 * `serializeWorkspaceConfig`.
 *
 * Invariants:
 *   - `default` is the implicit fallback for new chats; it cannot be
 *     deleted, cannot be renamed away, and other templates cannot be
 *     renamed *onto* it (would silently destroy whatever was there).
 *   - All actions return `{ ok: false, error }` on rejection rather
 *     than throwing — the UI surfaces `error` inline.
 *   - The reducer is pure: callers receive a fresh config and decide
 *     when to persist.
 *
 * Backed by `tests/unit/template-reducer.test.ts`.
 */
import type { WorkspaceConfig, WorkspaceTemplate } from '../../shared/workspace-config'

export type TemplateListAction =
  | { type: 'addTemplate'; name: string }
  | { type: 'deleteTemplate'; name: string }
  | { type: 'renameTemplate'; from: string; to: string }
  | { type: 'replaceTemplateBody'; name: string; body: WorkspaceTemplate }

export type TemplateListResult =
  | { ok: true; config: WorkspaceConfig }
  | { ok: false; error: string }

const RESERVED = 'default'

export function templateListReducer(
  config: WorkspaceConfig,
  action: TemplateListAction,
): TemplateListResult {
  const templates = { ...(config.templates ?? {}) }

  switch (action.type) {
    case 'addTemplate': {
      const name = action.name.trim()
      if (!name) return { ok: false, error: 'Template name is required.' }
      if (templates[name]) return { ok: false, error: `Template "${name}" already exists.` }
      templates[name] = { terminals: [{ label: 'Terminal 1' }] }
      return { ok: true, config: withTemplates(config, templates) }
    }

    case 'deleteTemplate': {
      if (action.name === RESERVED) {
        return { ok: false, error: 'The "default" template cannot be deleted.' }
      }
      if (!templates[action.name]) {
        return { ok: false, error: `Template "${action.name}" does not exist.` }
      }
      delete templates[action.name]
      return { ok: true, config: withTemplates(config, templates) }
    }

    case 'renameTemplate': {
      const from = action.from
      const to = action.to.trim()
      if (from === to) return { ok: true, config }
      if (!to) return { ok: false, error: 'New name is required.' }
      if (from === RESERVED) {
        return { ok: false, error: 'The "default" template cannot be renamed.' }
      }
      if (!templates[from]) {
        return { ok: false, error: `Template "${from}" does not exist.` }
      }
      if (templates[to]) {
        return { ok: false, error: `Template "${to}" already exists.` }
      }
      templates[to] = templates[from]
      delete templates[from]
      return { ok: true, config: withTemplates(config, templates) }
    }

    case 'replaceTemplateBody': {
      if (!templates[action.name]) {
        return { ok: false, error: `Template "${action.name}" does not exist.` }
      }
      templates[action.name] = action.body
      return { ok: true, config: withTemplates(config, templates) }
    }
  }
}

/**
 * Re-derive the `terminals` / `rows` mirror fields from `templates.default`
 * so legacy callers that read `config.terminals` directly stay consistent
 * with the modern templates map.
 */
function withTemplates(
  config: WorkspaceConfig,
  templates: Record<string, WorkspaceTemplate>,
): WorkspaceConfig {
  const def = templates[RESERVED]
  return {
    ...config,
    templates,
    terminals: def?.terminals ?? [],
    rows: def?.rows,
  }
}
