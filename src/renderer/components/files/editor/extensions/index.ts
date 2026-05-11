/**
 * Single composition point for the editor's CM6 extensions. Returns the
 * full extension array given a Buffer + theme + repoRoot. Splitting this
 * out keeps `EditorHost` itself dumb (mount the view, dispatch on change)
 * and makes the extension list testable without a DOM.
 *
 * The theme + read-only flag are wrapped in `Compartment`s so they can
 * be reconfigured (`view.dispatch({ effects: ... })`) without rebuilding
 * the whole state — that's how theme-store / read-only toggles propagate
 * to a live editor instance.
 */
import {
  EditorView,
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  keymap,
  rectangularSelection,
  crosshairCursor,
  dropCursor,
} from '@codemirror/view'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'
import {
  bracketMatching,
  defaultHighlightStyle,
  foldKeymap,
  foldGutter,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language'
import { search, searchKeymap } from '@codemirror/search'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'
import { Compartment, type Extension } from '@codemirror/state'
import { themeFor } from '../theme/highlightStyle'
import { gitGutter } from './gitGutter'
import { loadLanguageExtension, languageIdForPath } from './language'

export interface BuildExtensionsArgs {
  themeName: 'dark' | 'light' | 'translucent'
  /** When true the editor is non-editable (used while a save is in flight). */
  readOnly?: boolean
}

/** Compartments exposed for live reconfigure (theme switching, ro toggle). */
export const themeCompartment = new Compartment()
export const readOnlyCompartment = new Compartment()
export const languageCompartment = new Compartment()

/** Synchronous baseline extensions — no async language pack yet. */
export function buildExtensions(args: BuildExtensionsArgs): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    search({ top: true }),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    languageCompartment.of([]),
    themeCompartment.of(themeFor(args.themeName)),
    readOnlyCompartment.of(EditorView.editable.of(!args.readOnly)),
    gitGutter(),
  ]
}

/**
 * Lazily resolve the right `@codemirror/lang-*` pack and return a CM6
 * effect/extension caller can dispatch into the languageCompartment.
 * Handles unknown extensions by returning an empty array (plain text).
 */
export async function languageExtensionForPath(path: string): Promise<Extension> {
  const id = languageIdForPath(path)
  const ext = await loadLanguageExtension(id)
  return ext ?? []
}
