/**
 * What the generic ACP adapter needs to know about one agent: how to find
 * and start it, how to build its env, and the few places where agents
 * differ on the wire. Everything else (prompts, permissions, tool calls,
 * plans, usage, skills, resume) is plain Agent Client Protocol.
 */
import type { ModelInfo } from '@agentclientprotocol/sdk'
import type { GenericAcpAgent } from '@shared/acp-agents'
import type { ProviderSession, RuntimeMode } from '../../types'

/** Every provider kind the ACP adapter serves. */
export type AcpProviderKind = 'opencode' | GenericAcpAgent

/** Capabilities a launch config expects `initialize` to advertise. */
export type AcpExpectedCapability = 'loadSession' | 'resume' | 'fork' | 'image' | 'mcpHttp'

/**
 * How Switchboard's runtime mode reaches the agent.
 * - `fixed`: the agent has exactly these two mode ids (OpenCode: build/plan).
 * - `advertised`: use the mode ids `session/new` returns. Plan goes to a
 *   mode with id `plan` when there is one; every other runtime mode goes
 *   back to the mode the session started in. Without a plan mode, plan is
 *   enforced by the permission policy alone.
 */
export type AcpModeStrategy =
  | { kind: 'fixed'; plan: string; other: string }
  | { kind: 'advertised' }

/** Per-session result of `prepareSession`. */
export interface AcpSessionPrep {
  /** The env the agent is spawned with. */
  env: Record<string, string>
  /** MCP server names, longest first, used to label flattened tool names. */
  mcpServerNames: string[]
  /**
   * True when a permission request for this tool is one of Switchboard's own
   * MCP tools and may be allowed without a second prompt (the Switchboard
   * MCP server shows its own card). Only called when our server is registered.
   */
  autoAllowSwitchboardTool(toolName: string, mode: RuntimeMode): boolean
  /** How a tool name shows on an approval card. */
  displayToolName(toolName: string): string
}

export interface AcpLaunchConfig {
  readonly provider: AcpProviderKind
  /** Human name used in errors and logs ("OpenCode", "Gemini CLI"). */
  readonly label: string
  /** Error shown when the binary is missing; carries the install hint. */
  readonly notFoundMessage: string
  /** Added to an error the agent answers with "authentication required". */
  readonly signInHint: string
  readonly modes: AcpModeStrategy
  /** Logged as a warning when `initialize` does not advertise one of them. */
  readonly expectedCapabilities: readonly AcpExpectedCapability[]
  /** Absolute path of the agent binary, or null when not installed. */
  findBinary(): string | null
  /** Arguments that start the agent's ACP server on stdio. */
  args(cwd: string): string[]
  /** Spawn env: login shell env, process env, then the instance overlay. */
  buildEnv(overlay: Record<string, string>): Record<string, string>
  /** Runs before any session state exists; throws to refuse the binary. */
  preflight?(binPath: string, env: Record<string, string>, cwd: string): Promise<void>
  /** Reads the agent's own config to finish the env and permission rules. */
  prepareSession?(input: { cwd: string; env: Record<string, string>; runtimeMode: RuntimeMode; switchboardMcp: boolean }): Promise<AcpSessionPrep>
  /** Label for a catalog model in the picker. */
  modelLabel(model: ModelInfo): string
  /**
   * Model variants the agent reports in `session/set_model`'s `_meta`
   * (OpenCode only), or null.
   */
  modelVariants?(meta: unknown): { modelId?: string; variant: string; availableVariants: string[] } | null
  /** Called once, after the first prompt of a session is dispatched. */
  onFirstPrompt?(input: { sessionId: string; message: string; session: ProviderSession }): Promise<void>
}
