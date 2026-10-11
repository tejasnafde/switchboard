/**
 * Settings > Accounts > Add agent: one dialog, three steps. Agent picks a
 * built-in agent (or a local ACP command), Sign-in sets up and tests its
 * credentials, Config names the account and saves it.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ACP_COMMAND_AGENT } from '@shared/acp-agents'
import type { AcpCommandConfig } from '@shared/acp-command'
import { oauthCreateDirCommand } from '@shared/provider-auth-format'
import { agentLabel, providerKindFor, type AgentProvider, type ProviderInstance } from '@shared/types'
import { defaultModelFor, modelsForAgent } from '@shared/models'
import { useProviderInstanceStore } from '../../stores/provider-instance-store'
import { createRendererLogger } from '../../logger'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Combobox } from '../ui/combobox'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { RadioGroup, RadioGroupCard } from '../ui/radio-group'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import {
  ACCENT_PALETTE,
  ADD_AGENT_KINDS,
  ADD_AGENT_STEPS,
  AGENT_AVATAR_CLASS,
  addAgentInput,
  agentInitials,
  agentTileLabel,
  agentTileStatus,
  avatarInitials,
  defaultSignInFolder,
  draftCredentials,
  envFromRows,
  envRowErrors,
  folderLoginCommand,
  installCommand,
  isTestedAgent,
  localCommandConfig,
  nameFromCommand,
  nameTaken,
  signInMethods,
  suggestedName,
  type AddAgentDraft,
  type AddAgentStep,
  type EnvRow,
  type LocalCommandForm,
  type SignInMethod,
} from './add-agent-model'
import {
  ACP_REGISTRY_SEARCH_ENABLED,
  STUB_ACP_REGISTRY_SOURCE,
  type AcpRegistryEntry,
  type AcpRegistryResult,
} from './acp-registry-source'

const log = createRendererLogger('settings:add-agent')

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing'; startedAt: number }
  | { kind: 'done'; ok: boolean; message: string }

export interface AddedAgent {
  instance: ProviderInstance
  useForNewChats: boolean
  /** The model picked for new chats of this agent, when it changed. */
  model: string | null
}

export function AddAgentDialog({
  instances,
  storedModel,
  onClose,
  onAdded,
}: {
  instances: readonly ProviderInstance[]
  /** The default model setting per agent, as Accounts read it. */
  storedModel: (kind: AgentProvider) => string
  onClose: () => void
  onAdded: (added: AddedAgent) => void
}) {
  const upsert = useProviderInstanceStore((s) => s.upsert)
  const [step, setStep] = useState<AddAgentStep>('agent')
  const [kind, setKind] = useState<AgentProvider>('claude-code')
  const [installed, setInstalled] = useState<Partial<Record<AgentProvider, boolean>>>({})
  const [localMode, setLocalMode] = useState(false)
  const [local, setLocal] = useState<LocalCommandForm>({ command: '', args: '', cwd: '' })
  const [localError, setLocalError] = useState<string | null>(null)
  const [localFound, setLocalFound] = useState<string | null>(null)
  const [launch, setLaunch] = useState<AcpCommandConfig | null>(null)
  const [checkingLocal, setCheckingLocal] = useState(false)

  const [methodId, setMethodId] = useState<SignInMethod['id']>('folder')
  const [folder, setFolder] = useState('')
  const [key, setKey] = useState('')
  const [envRows, setEnvRows] = useState<EnvRow[]>([{ key: '', value: '' }])
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  const [name, setName] = useState('')
  const [accent, setAccent] = useState<string>(ACCENT_PALETTE[1])
  const [model, setModel] = useState('')
  const [useForNewChats, setUseForNewChats] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const agent: AgentProvider = localMode ? ACP_COMMAND_AGENT : kind
  const methods = signInMethods(agent)
  const method = methods.find((m) => m.id === methodId) ?? methods[0]
  const label = localMode ? name || nameFromCommand(local.command) || agentLabel(agent) : agentLabel(agent)

  // Any edit after a check makes its answer stale; a late answer for an old
  // draft must not land either.
  const testSeq = useRef(0)
  function resetTest() {
    testSeq.current++
    setTest({ kind: 'idle' })
  }

  const probeSeq = useRef(0)
  function recheck() {
    const seq = ++probeSeq.current
    setInstalled({})
    for (const k of ADD_AGENT_KINDS) {
      window.api.provider
        .isAvailable(providerKindFor(k))
        .catch((err: unknown) => {
          log.warn(`availability check for ${k} failed`, err)
          return false
        })
        .then((ok) => {
          if (seq === probeSeq.current) setInstalled((prev) => ({ ...prev, [k]: ok }))
        })
    }
  }
  useEffect(recheck, [])

  function draft(): AddAgentDraft {
    return { kind: agent, method, folder, key, envRows, launch: localMode ? launch : null }
  }

  async function runTest() {
    const parsed = method.id === 'env' ? envFromRows(envRows) : null
    if (parsed && 'error' in parsed) {
      setTest({ kind: 'done', ok: false, message: parsed.error })
      return
    }
    const seq = ++testSeq.current
    setTest({ kind: 'testing', startedAt: Date.now() })
    let result: { ok: boolean; message: string }
    try {
      result = await window.api.providerInstances.testDraft(draftCredentials(draft()))
    } catch (err) {
      log.warn('sign-in test failed', err)
      result = { ok: false, message: err instanceof Error ? err.message : 'The test could not run.' }
    }
    if (seq === testSeq.current) setTest({ kind: 'done', ...result })
  }

  // Name and folder follow the picked agent until the user edits them.
  const [nameTouched, setNameTouched] = useState(false)
  const [folderTouched, setFolderTouched] = useState(false)
  function enterSignIn(nextAgent: AgentProvider, nextName: string) {
    const next = signInMethods(nextAgent)
    if (!next.some((m) => m.id === methodId)) setMethodId(next[0].id)
    const accountName = nameTouched ? name : nextName
    if (!nameTouched) setName(nextName)
    if (!folderTouched) setFolder(defaultSignInFolder(nextAgent, accountName))
    setStep('sign-in')
  }

  async function continueFromAgent() {
    if (!localMode) {
      enterSignIn(kind, suggestedName(kind, instances))
      return
    }
    const parsed = localCommandConfig(local)
    if ('error' in parsed) {
      setLocalError(parsed.error)
      return
    }
    setCheckingLocal(true)
    try {
      const result = await window.api.providerInstances.testDraft({
        agentType: ACP_COMMAND_AGENT,
        authMode: 'env',
        configJson: { launch: parsed.config },
      })
      if (!result.ok) {
        setLocalError(result.message)
        return
      }
      setLocalError(null)
      setLocalFound(result.message)
      setLaunch(parsed.config)
      enterSignIn(
        ACP_COMMAND_AGENT,
        suggestedName(ACP_COMMAND_AGENT, instances, nameFromCommand(parsed.config.command)),
      )
    } catch (err) {
      log.warn('local command check failed', err)
      setLocalError('The command could not be checked.')
    } finally {
      setCheckingLocal(false)
    }
  }

  function addFromRegistry(entry: AcpRegistryEntry) {
    setLocalMode(true)
    setLocal({ command: entry.command, args: entry.args.join(' '), cwd: '' })
    setName(entry.name)
    setNameTouched(true)
    setLocalError(null)
  }

  async function save() {
    const taken = nameTaken(agent, name, instances)
    if (!name.trim() || taken || envInvalid) return
    setSaving(true)
    setSaveError(null)
    try {
      const instance = await upsert(addAgentInput(draft(), { name, accentColor: accent }))
      onAdded({ instance, useForNewChats, model: model && model !== storedModel(agent) ? model : null })
      onClose()
    } catch (err) {
      log.warn('saving the new account failed', err)
      setSaveError(err instanceof Error ? err.message : 'The account could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  const kindInstalled = installed[kind]
  const canContinueAgent = localMode ? !!local.command.trim() && !checkingLocal : kindInstalled === true
  const envErrors = method.id === 'env' ? envRowErrors(envRows) : []
  const envInvalid = envErrors.some((e) => e !== null)
  const nameError = name.trim() && nameTaken(agent, name, instances) ? 'An account with this name exists.' : null
  const models = modelsForAgent(agent)
  const stepIndex = ADD_AGENT_STEPS.findIndex((s) => s.id === step)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent
        data-testid="add-agent-dialog"
        overlayClassName="z-[1100] bg-[rgba(0,0,0,0.55)]"
        className="sb-floating-surface inset-x-0 top-[8vh] z-[1100] mx-auto flex max-h-[84vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-[10px] border border-border text-[13px] text-foreground"
      >
        <div className="flex items-center gap-2.5 px-5 pt-4">
          {step !== 'agent' && <AgentAvatar kind={agent} label={label} small />}
          <DialogTitle className="m-0 flex-1 text-[14px] font-[600]">
            {step === 'agent' ? 'Add agent' : label}
          </DialogTitle>
          <Button variant="ghost" size="icon-xs" aria-label="Close" onClick={onClose} disabled={saving}>
            <Glyph d="M4 4l8 8M12 4l-8 8" />
          </Button>
        </div>
        <DialogDescription className="sr-only">
          Pick an agent, sign it in, and name the account. Step {stepIndex + 1} of 3.
        </DialogDescription>
        <ol className="mx-0 mt-3 mb-0 flex list-none gap-5 border-b border-border px-5 text-[12.5px]">
          {ADD_AGENT_STEPS.map((s, i) => (
            <li
              key={s.id}
              aria-current={s.id === step ? 'step' : undefined}
              className={cn(
                '-mb-px inline-flex items-center gap-[5px] border-b-2 border-transparent pb-[9px] text-[var(--text-muted)]',
                i < stepIndex && 'text-muted-foreground',
                s.id === step && 'border-primary text-foreground',
              )}
            >
              {i < stepIndex && <Glyph d="M3 8.5 6.5 12 13 4.5" className="size-3 text-[var(--success)]" />}
              {s.label}
            </li>
          ))}
        </ol>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-[18px] pb-1.5">
          {step === 'agent' && !localMode && (
            <>
              <SectionHead
                title="Built in"
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-1.5 font-[400] text-muted-foreground"
                    onClick={recheck}
                  >
                    <Glyph d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" className="size-3" />
                    Recheck
                  </Button>
                }
              />
              <RadioGroup
                aria-label="Agent"
                value={kind}
                onValueChange={(value) => {
                  setKind(value as AgentProvider)
                  resetTest()
                }}
                className="mb-5 grid-cols-4 gap-2"
              >
                {ADD_AGENT_KINDS.map((k) => {
                  const off = installed[k] === false
                  const accounts = instances.filter((i) => i.agentType === k).length
                  return (
                    <RadioGroupCard key={k} value={k} aria-label={agentLabel(k)}>
                      <AgentAvatar kind={k} label={agentLabel(k)} dim={off} />
                      <span className="min-w-0">
                        <span className={cn('block truncate font-[500]', off && 'text-muted-foreground')}>
                          {agentTileLabel(k)}
                        </span>
                        <span className="block truncate text-[11.5px] text-muted-foreground">
                          {agentTileStatus(installed[k], accounts)}
                        </span>
                      </span>
                    </RadioGroupCard>
                  )
                })}
              </RadioGroup>
              {kindInstalled === false && installCommand(kind) && (
                <div className="mb-4">
                  <CommandLine command={installCommand(kind)!} />
                  <Hint>Install it in a terminal, then Recheck. Continue stays off until it is found.</Hint>
                </div>
              )}
              {ACP_REGISTRY_SEARCH_ENABLED && (
                <RegistrySection onAdd={addFromRegistry} onUseLocal={() => setLocalMode(true)} />
              )}
            </>
          )}

          {step === 'agent' && localMode && (
            <>
              <SectionHead title="Local command" />
              <Field
                label="Command"
                htmlFor="add-agent-command"
                error={localError}
                hint={
                  localError
                    ? undefined
                    : localFound && launch?.command === local.command.trim()
                      ? localFound
                      : undefined
                }
              >
                <Input
                  id="add-agent-command"
                  className="[font-family:var(--font-mono)] text-[12px]"
                  placeholder="kestrel-acp"
                  value={local.command}
                  aria-invalid={!!localError}
                  onChange={(e) => {
                    setLocal({ ...local, command: e.target.value })
                    setLocalError(null)
                  }}
                />
              </Field>
              <Field label="Arguments" htmlFor="add-agent-args">
                <Input
                  id="add-agent-args"
                  className="[font-family:var(--font-mono)] text-[12px]"
                  placeholder="acp --log-level warn"
                  value={local.args}
                  onChange={(e) => {
                    setLocal({ ...local, args: e.target.value })
                    setLocalError(null)
                  }}
                />
              </Field>
              <Field
                label="Working folder"
                htmlFor="add-agent-cwd"
                hint="Leave empty to start it in the chat's project folder."
              >
                <Input
                  id="add-agent-cwd"
                  className="[font-family:var(--font-mono)] text-[12px]"
                  placeholder="Chat's project folder"
                  value={local.cwd}
                  onChange={(e) => setLocal({ ...local, cwd: e.target.value })}
                />
              </Field>
              <Hint>
                The agent must speak the Agent Client Protocol on stdio. Keys it needs are set in the next step.
              </Hint>
            </>
          )}

          {step === 'sign-in' && (
            <SignInStep
              agent={agent}
              methods={methods}
              method={method}
              onMethod={(id) => {
                setMethodId(id)
                resetTest()
              }}
              folder={folder}
              onFolder={(v) => {
                setFolder(v)
                setFolderTouched(true)
                resetTest()
              }}
              apiKey={key}
              onKey={(v) => {
                setKey(v)
                resetTest()
              }}
              envRows={envRows}
              envErrors={envErrors}
              onEnvRows={(rows) => {
                setEnvRows(rows)
                resetTest()
              }}
              test={test}
              onTest={() => void runTest()}
            />
          )}

          {step === 'config' && (
            <>
              <div className="grid grid-cols-[1fr_auto] gap-4">
                <Field label="Name" htmlFor="add-agent-name" error={nameError}>
                  <Input
                    id="add-agent-name"
                    value={name}
                    aria-invalid={!!nameError}
                    onChange={(e) => {
                      setName(e.target.value)
                      setNameTouched(true)
                    }}
                  />
                </Field>
                <Field label="Color">
                  <ToggleGroup
                    type="single"
                    aria-label="Color"
                    value={accent}
                    onValueChange={(v) => v && setAccent(v)}
                    className="h-8 items-center gap-2 border-0 bg-transparent p-0"
                  >
                    {ACCENT_PALETTE.map((c) => (
                      <ToggleGroupItem
                        key={c}
                        value={c}
                        aria-label={`Color ${c}`}
                        className="size-5 rounded-full p-0 data-[state=on]:shadow-[0_0_0_2px_var(--bg-elevated),0_0_0_4px_var(--text-primary)]"
                        // The swatch colour is data, not styling.
                        style={{ background: c }}
                      />
                    ))}
                  </ToggleGroup>
                </Field>
              </div>
              <Field label="Default model" htmlFor="add-agent-model">
                {models.length > 0 ? (
                  <Combobox
                    id="add-agent-model"
                    value={model || storedModel(agent) || defaultModelFor(agent)}
                    onValueChange={setModel}
                    options={models.map((m) => ({ value: m.id, label: m.label }))}
                    contentClassName="z-[1200]"
                    className="h-8 w-full"
                  />
                ) : (
                  <Input id="add-agent-model" disabled value="" placeholder="Agent default" />
                )}
              </Field>
              {models.length > 0 ? (
                <Hint className="-mt-2.5 mb-4">Applies to new chats of every {agentLabel(agent)} account.</Hint>
              ) : (
                <Hint className="-mt-2.5 mb-4">The agent lists its models once a chat starts.</Hint>
              )}
              <label className="mb-4 flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
                <Checkbox checked={useForNewChats} onCheckedChange={(v) => setUseForNewChats(v === true)} />
                Use for new chats
              </label>
              {!isTestedAgent(agent) && (
                <Note>
                  <b className="font-[500] text-foreground">{label} is not tested with Switchboard</b>, so its new chats
                  start in plan mode, it asks before each write, and it gets 3 minutes to connect. Pick another mode in
                  the chat to change it.
                </Note>
              )}
              {test.kind === 'done' && !test.ok && (
                <Note tone="warn" className="mt-2">
                  The sign-in test failed. You can still add it, and test it again from its card.
                </Note>
              )}
              {saveError && (
                <div role="alert" className="mt-2 text-[12px] text-destructive">
                  {saveError}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 pt-3 pb-3.5">
          <span className="flex-1">
            {step === 'agent' && (
              <Button
                variant="ghost"
                size="sm"
                className="font-[500] text-muted-foreground"
                disabled={checkingLocal}
                onClick={() => {
                  setLocalMode(!localMode)
                  setLocalError(null)
                  resetTest()
                }}
              >
                {localMode ? 'Pick a built-in agent' : 'Use a local command'}
              </Button>
            )}
          </span>
          {step === 'agent' ? (
            <Button variant="ghost" size="sm" className="font-[500] text-muted-foreground" onClick={onClose}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="font-[500] text-muted-foreground"
              disabled={saving}
              onClick={() => setStep(step === 'config' ? 'sign-in' : 'agent')}
            >
              Back
            </Button>
          )}
          {step === 'agent' && (
            <Button size="sm" disabled={!canContinueAgent} onClick={() => void continueFromAgent()}>
              {checkingLocal ? 'Checking…' : 'Continue'}
            </Button>
          )}
          {step === 'sign-in' && (
            <Button size="sm" disabled={envInvalid} onClick={() => setStep('config')}>
              Continue
            </Button>
          )}
          {step === 'config' && (
            <Button
              size="sm"
              disabled={saving || !name.trim() || !!nameError || envInvalid}
              onClick={() => void save()}
            >
              {saving ? 'Adding…' : 'Add agent'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SignInStep({
  agent,
  methods,
  method,
  onMethod,
  folder,
  onFolder,
  apiKey,
  onKey,
  envRows,
  envErrors,
  onEnvRows,
  test,
  onTest,
}: {
  agent: AgentProvider
  methods: SignInMethod[]
  method: SignInMethod
  onMethod: (id: SignInMethod['id']) => void
  folder: string
  onFolder: (v: string) => void
  apiKey: string
  onKey: (v: string) => void
  envRows: EnvRow[]
  envErrors: (string | null)[]
  onEnvRows: (rows: EnvRow[]) => void
  test: TestState
  onTest: () => void
}) {
  const [advanced, setAdvanced] = useState(false)
  const loginCommand = folder.trim() ? `${oauthCreateDirCommand(folder)} && ${folderLoginCommand(agent, folder)}` : ''
  return (
    <>
      {methods.length > 1 && (
        <Field label="Sign in with">
          <ToggleGroup
            type="single"
            aria-label="Sign in with"
            value={method.id}
            onValueChange={(v) => v && onMethod(v as SignInMethod['id'])}
          >
            {methods.map((m) => (
              <ToggleGroupItem key={m.id} value={m.id}>
                {m.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      )}

      {method.id === 'folder' && (
        <Field label="Run this once in a terminal and finish in the browser">
          <CommandLine command={loginCommand || 'Enter a sign-in folder under Advanced.'} copyable={!!loginCommand} />
          <TestRow test={test} onTest={onTest} label="Check sign-in" />
        </Field>
      )}

      {method.id === 'terminal' && (
        <Field label="Run this once in a terminal and sign in">
          <CommandLine command={method.command} />
          <Hint>
            {method.hint ? `${method.hint} ` : ''}
            {agentLabel(agent)} keeps this sign-in itself, so every account of it shares it.
          </Hint>
          <TestRow test={test} onTest={onTest} label="Check" />
        </Field>
      )}

      {method.id === 'key' && (
        <Field label={method.envKey} htmlFor="add-agent-key" hint="Stored encrypted on this machine.">
          <Input
            id="add-agent-key"
            type="password"
            autoComplete="off"
            className="tracking-[0.15em]"
            value={apiKey}
            onChange={(e) => onKey(e.target.value)}
          />
          <TestRow test={test} onTest={onTest} label="Test" />
        </Field>
      )}

      {method.id === 'env' && (
        <Field label={method.label} hint={method.hint}>
          {envRows.map((row, i) => (
            <div key={i} className="mb-1.5">
              <div className="flex gap-1.5">
                <Input
                  aria-label="Variable name"
                  aria-invalid={!!envErrors[i]}
                  className="flex-1 [font-family:var(--font-mono)] text-[12px]"
                  placeholder="KEY"
                  value={row.key}
                  onChange={(e) => onEnvRows(envRows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                />
                <Input
                  aria-label="Value"
                  type="password"
                  autoComplete="off"
                  className="flex-[2]"
                  placeholder="value"
                  value={row.value}
                  onChange={(e) => onEnvRows(envRows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Remove variable"
                  onClick={() => onEnvRows(envRows.filter((_, j) => j !== i))}
                >
                  <Glyph d="M4 4l8 8M12 4l-8 8" />
                </Button>
              </div>
              {envErrors[i] && (
                <div role="alert" className="mt-1 text-[12px] text-destructive">
                  {envErrors[i]}
                </div>
              )}
            </div>
          ))}
          <div className="flex items-center">
            <Button
              variant="ghost"
              size="sm"
              className="px-0 font-[500] text-muted-foreground hover:bg-transparent"
              onClick={() => onEnvRows([...envRows, { key: '', value: '' }])}
            >
              + Add variable
            </Button>
          </div>
          <TestRow test={test} onTest={onTest} label="Test" />
        </Field>
      )}

      {method.id === 'folder' && (
        <div className="mt-4 border-t border-border pt-3">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={advanced}
            className="px-0 font-[400] text-muted-foreground hover:bg-transparent"
            onClick={() => setAdvanced(!advanced)}
          >
            <Glyph d={advanced ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} className="size-3" />
            Advanced
          </Button>
          {advanced && (
            <Field
              label="Sign-in folder"
              htmlFor="add-agent-folder"
              hint="One folder per account, so two accounts never share a token."
              className="mt-2"
            >
              <Input
                id="add-agent-folder"
                className="[font-family:var(--font-mono)] text-[12px]"
                value={folder}
                onChange={(e) => onFolder(e.target.value)}
              />
            </Field>
          )}
        </div>
      )}
    </>
  )
}

function TestRow({ test, onTest, label }: { test: TestState; onTest: () => void; label: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (test.kind !== 'testing') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [test.kind])
  return (
    <div className="mt-2">
      <Button variant="outline" size="sm" disabled={test.kind === 'testing'} onClick={onTest}>
        {label}
      </Button>
      <div aria-live="polite" className="mt-2 min-h-[18px]">
        {test.kind === 'testing' && (
          <span className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <Spinner />
            Checking… {Math.max(0, Math.round((now - test.startedAt) / 1000))} s
          </span>
        )}
        {test.kind === 'done' && (
          <span
            role={test.ok ? 'status' : 'alert'}
            className={cn(
              'flex items-start gap-2 text-[12.5px] leading-[1.5]',
              test.ok ? 'text-[var(--success)]' : 'text-muted-foreground',
            )}
          >
            <Glyph
              d={test.ok ? 'M5 8.3l2 2 4-4.3' : 'M8 4.8v4M8 11.2v.1'}
              circle
              className={cn('mt-0.5', !test.ok && 'text-destructive')}
            />
            <span className="min-w-0 break-words">{test.message}</span>
          </span>
        )}
      </div>
    </div>
  )
}

function RegistrySection({ onAdd, onUseLocal }: { onAdd: (entry: AcpRegistryEntry) => void; onUseLocal: () => void }) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<AcpRegistryResult | null>(null)
  const [attempt, setAttempt] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    const ticket = ++seq.current
    setResult(null)
    STUB_ACP_REGISTRY_SOURCE.search(query.trim())
      .catch((err: unknown): AcpRegistryResult => {
        log.warn('registry search failed', err)
        return { status: 'unreachable' }
      })
      .then((next) => {
        if (ticket === seq.current) setResult(next)
      })
  }, [query, attempt])
  const unreachable = result?.status === 'unreachable'
  return (
    <>
      <SectionHead title="ACP registry" action={result?.status === 'ok' ? `${result.total} agents` : undefined} />
      <div className="overflow-hidden rounded-[8px] border border-border">
        <div
          className={cn(
            'flex items-center gap-2 border-b border-border bg-[var(--bg-secondary)] px-2.5',
            unreachable && 'opacity-50',
          )}
        >
          <Glyph d="M10.5 10.5 14 14" circle={false} search className="text-[var(--text-muted)]" />
          <Input
            aria-label="Search the registry"
            placeholder="Search the registry"
            disabled={unreachable}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-[34px] border-0 bg-transparent px-0 focus-visible:shadow-none"
          />
          {result === null && <Spinner />}
          {result?.status === 'ok' && query.trim() && (
            <span className="shrink-0 text-[11.5px] text-[var(--text-muted)]">{result.entries.length} results</span>
          )}
        </div>
        {unreachable && (
          <div className="flex items-center gap-3 px-3.5 py-[18px] text-[12.5px] text-muted-foreground">
            <span className="flex-1">Could not reach the registry. Built-in agents and local commands still work.</span>
            <Button variant="outline" size="sm" onClick={() => setAttempt(attempt + 1)}>
              Retry
            </Button>
          </div>
        )}
        {result?.status === 'ok' && result.entries.length === 0 && (
          <div className="px-3.5 py-[18px] text-center text-[12.5px] text-muted-foreground">
            Nothing matches "{query.trim()}".
            <br />
            Already installed?{' '}
            <Button
              variant="ghost"
              size="sm"
              className="h-auto px-0 font-[500] text-primary hover:bg-transparent"
              onClick={onUseLocal}
            >
              Use a local command
            </Button>
          </div>
        )}
        {result?.status === 'ok' &&
          result.entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2.5 border-t border-border px-3 py-[9px] first:border-t-0"
            >
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-[#2f9e8f] text-[9.5px] font-[700] text-white">
                {agentInitials(entry.name)}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="whitespace-nowrap font-[500]">{entry.name}</span>
                <span className="truncate text-[12px] text-muted-foreground">{entry.description}</span>
              </span>
              <Button variant="outline" size="sm" onClick={() => onAdd(entry)}>
                Add
              </Button>
            </div>
          ))}
      </div>
    </>
  )
}

function AgentAvatar({
  kind,
  label,
  small = false,
  dim = false,
}: {
  kind: AgentProvider
  label: string
  small?: boolean
  dim?: boolean
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-[700] tracking-[0.02em] text-white',
        small ? 'size-[22px] rounded-[6px] text-[9px]' : 'size-[26px] rounded-[7px] text-[10px]',
        AGENT_AVATAR_CLASS[kind],
        dim && 'opacity-45',
      )}
    >
      {avatarInitials(kind, label)}
    </span>
  )
}

function CommandLine({ command, copyable = true }: { command: string; copyable?: boolean }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  async function copy() {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
    } catch (err) {
      log.warn('clipboard write failed', err)
      setCopied(false)
    }
  }
  return (
    <div className="flex items-center gap-2.5 rounded-md border border-border bg-[var(--bg-primary)] py-[3px] pr-1 pl-2.5 [font-family:var(--font-mono)] text-[12px] text-foreground">
      <span className="min-w-0 flex-1 break-all py-1">{command}</span>
      {copyable && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 px-1.5 font-[400] text-muted-foreground [font-family:var(--font-sans)]"
          onClick={() => void copy()}
        >
          <Glyph
            d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2M7 5.5h6.5v8H5.5V7A1.5 1.5 0 0 1 7 5.5Z"
            className="size-3"
          />
          {copied === null ? 'Copy' : copied ? 'Copied' : 'Copy failed'}
        </Button>
      )}
    </div>
  )
}

function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-2 flex h-6 items-center text-[11px] font-[600] tracking-[0.06em] text-[var(--text-muted)] uppercase">
      {title}
      {action !== undefined && (
        <span className="ml-auto text-[12px] font-[400] tracking-normal normal-case">{action}</span>
      )}
    </div>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: string
  htmlFor?: string
  hint?: string
  error?: string | null
  className?: string
  children: ReactNode
}) {
  return (
    <div className={cn('mb-4', className)}>
      <label htmlFor={htmlFor} className="mb-1.5 block text-[12px] font-[500] text-muted-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <div role="alert" className="mt-1.5 text-[12px] text-destructive">
          {error}
        </div>
      ) : (
        hint && <Hint>{hint}</Hint>
      )}
    </div>
  )
}

function Hint({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-1.5 text-[12px] text-[var(--text-muted)]', className)}>{children}</div>
}

function Note({ children, tone, className }: { children: ReactNode; tone?: 'warn'; className?: string }) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-[8px] border border-border bg-[var(--bg-surface)] px-3 py-2.5 text-[12.5px] leading-[1.5] text-muted-foreground',
        className,
      )}
    >
      <Glyph d="M8 4.8v4M8 11.2v.1" circle className={cn('mt-0.5', tone === 'warn' && 'text-[var(--warning)]')} />
      <span>{children}</span>
    </div>
  )
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-3 shrink-0 animate-spin rounded-full border-2 border-[rgba(255,255,255,0.15)] border-t-primary motion-reduce:animate-none"
    />
  )
}

/** A 16-unit stroke icon; `circle` adds a ring, `search` a lens. */
function Glyph({
  d,
  circle = false,
  search = false,
  className,
}: {
  d: string
  circle?: boolean
  search?: boolean
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      className={cn('size-3.5 shrink-0', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {circle && <circle cx="8" cy="8" r="6.5" />}
      {search && <circle cx="7" cy="7" r="4.5" />}
      <path d={d} />
    </svg>
  )
}
