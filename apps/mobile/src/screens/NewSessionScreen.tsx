import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useHeaderHeight } from '@react-navigation/elements'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { ProviderKind, RuntimeMode } from '@shared/provider-events'
import type { AgentType, ProviderInstance } from '@shared/types'
import type { WorktreeSetupPolicy } from '@shared/worktree-creation'
import { generateTitle } from '@shared/auto-title'
import { createLogger } from '@shared/logger'
import { modelsForAgent } from '@shared/models'
import { isRuntimeMode } from '@shared/session-defaults'
import type { RootStackParamList } from '../../App'
import { ModePicker } from '../components/ModePicker'
import { MicButton, VoiceNoteBar, type VoiceNote } from '../components/MicButton'
import { keyboardAvoidance } from '../lib/keyboardAvoidance'
import {
  createNewSessionCreationCoordinator,
  newSessionCreationActions,
  type MobileNewSessionCreationState,
  type ParentCheckoutRequest,
} from '../lib/newSessionCreation'
import { mobileNewSessionCreationStorage } from '../lib/newSessionCreationStorage'
import { agentTypeFor, profilesFor } from '../lib/profiles'
import { buildTurn } from '../lib/turnSubmit'
import { restoredWorktreeForm, shouldOfferWorktreeCreation } from '../lib/worktreeCapability'
import { useChatStore, threadKey } from '../stores/chat'
import { getClient } from '../stores/connections'
import { enqueue } from '../stores/outbox'
import { usePrefsStore } from '../stores/prefs'
import { colors, fonts, radius, space, type, HIT } from '../theme'

const log = createLogger('screen:new-session')

type Props = NativeStackScreenProps<RootStackParamList, 'NewSession'>
type CheckoutKind = 'parent-checkout' | 'worktree'

const PROVIDERS: { kind: ProviderKind; label: string; blurb: string }[] = [
  { kind: 'claude', label: 'Claude Code', blurb: 'Anthropic agent SDK, resumable sessions' },
  { kind: 'codex', label: 'Codex', blurb: 'OpenAI codex app-server' },
  { kind: 'opencode', label: 'OpenCode', blurb: 'Agent Client Protocol' },
]

const SETUP_POLICIES: { value: WorktreeSetupPolicy; label: string }[] = [
  { value: 'skip', label: 'Skip setup' },
  { value: 'inherit', label: 'Use project default' },
  { value: 'run', label: 'Run setup' },
]

function providerKindFor(agentType: AgentType): ProviderKind {
  if (agentType === 'codex') return 'codex'
  if (agentType === 'opencode') return 'opencode'
  return 'claude'
}

export default function NewSessionScreen({ route, navigation }: Props) {
  const { connectionId, projectPath, projectName } = route.params
  const headerHeight = useHeaderHeight()
  const [provider, setProvider] = useState<ProviderKind>('claude')
  const [mode, setMode] = useState<RuntimeMode>('sandbox')
  const [firstMessage, setFirstMessage] = useState('')
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [instances, setInstances] = useState<ProviderInstance[]>([])
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined)
  const [model, setModel] = useState('')
  const [checkoutKind, setCheckoutKind] = useState<CheckoutKind>('parent-checkout')
  const [baseRef, setBaseRef] = useState('HEAD')
  const [setupPolicy, setSetupPolicy] = useState<WorktreeSetupPolicy>('skip')
  const [creationState, setCreationState] = useState<MobileNewSessionCreationState>({ status: 'idle' })
  const coordinatorRef = useRef<ReturnType<typeof createNewSessionCreationCoordinator> | null>(null)

  const agentType = agentTypeFor(provider)
  const activeWorktreeCreation = creationState.intent?.checkout.kind === 'worktree' &&
    creationState.status !== 'idle' && creationState.status !== 'ready'
  const offerWorktreeCreation = shouldOfferWorktreeCreation(
    getClient(connectionId)?.supportsCapability('worktree_creation_v1'),
    creationState,
  )
  const busy = creationState.status === 'submitting' || creationState.status === 'pending'
  const creationActions = newSessionCreationActions(creationState)

  useEffect(() => {
    const restored = restoredWorktreeForm(creationState.intent)
    if (!restored || creationState.status === 'ready') return
    setCheckoutKind(restored.checkoutKind)
    setBaseRef(restored.baseRef)
    setSetupPolicy(restored.setupPolicy)
    setProvider(restored.provider.kind ?? providerKindFor(restored.agentType))
    setInstanceId(restored.provider.instanceId)
    setModel(restored.provider.model ?? '')
    if (restored.provider.runtimeMode) setMode(restored.provider.runtimeMode)
    setFirstMessage(restored.firstMessage)
  }, [creationState.creationId, creationState.intent, creationState.status])

  useEffect(() => {
    const client = getClient(connectionId)
    if (!client) return
    let cancelled = false
    client
      .listInstances()
      .then((rows) => {
        if (!cancelled) setInstances(rows)
      })
      .catch((err) => log.warn('listInstances failed - hiding the profile row', err))
    return () => {
      cancelled = true
    }
  }, [connectionId])

  useEffect(() => {
    if (activeWorktreeCreation) return
    const client = getClient(connectionId)
    if (!client) return
    let cancelled = false
    client
      .getSessionDefaults(agentType)
      .then((defaults) => {
        if (cancelled) return
        if (isRuntimeMode(defaults.runtimeMode)) setMode(defaults.runtimeMode)
        if (defaults.model) setModel(defaults.model)
        if (defaults.instanceId) setInstanceId(defaults.instanceId)
      })
      .catch((err) => log.warn('could not read the machine defaults - using local ones', err))
    return () => {
      cancelled = true
    }
  }, [connectionId, agentType, activeWorktreeCreation])

  const agentInstances = useMemo(() => profilesFor(instances, provider), [instances, provider])
  const selectedInstance = agentInstances.find((i) => i.id === instanceId) ?? agentInstances[0]
  const models = useMemo(() => modelsForAgent(agentType), [agentType])

  useEffect(() => {
    if (activeWorktreeCreation) return
    setInstanceId(undefined)
    setModel('')
  }, [agentType, activeWorktreeCreation])

  useEffect(() => {
    const client = getClient(connectionId)
    if (!client) {
      setError('Backend not connected yet.')
      return
    }

    const createParentCheckout = async (request: ParentCheckoutRequest) => {
      const requestProvider = request.provider.kind ?? providerKindFor(request.conversation.agentType)
      const runtimeMode = request.provider.runtimeMode ?? 'sandbox'
      await client.createConversation({
        id: request.conversation.id,
        projectPath: request.projectPath,
        agentType: request.conversation.agentType,
      })
      await client.startSession({
        threadId: request.conversation.id,
        provider: requestProvider,
        cwd: request.projectPath,
        runtimeMode,
        instanceId: request.provider.instanceId,
        model: request.provider.model,
      })

      const key = threadKey(connectionId, request.conversation.id)
      useChatStore.getState().setRuntimeMode(key, runtimeMode)
      if (request.firstMessage) {
        const turn = buildTurn({
          connectionId,
          threadId: request.conversation.id,
          text: request.firstMessage,
          runtimeMode,
          titleCandidate: generateTitle(request.firstMessage),
        })
        useChatStore.getState().addUserMessage(key, request.firstMessage, undefined, turn.bubbleId)
        enqueue(turn.queued).catch((err: unknown) => {
          useChatStore.getState().removeUserMessage(key, turn.bubbleId)
          usePrefsStore.getState().rememberDraft(key, request.firstMessage ?? '')
          useChatStore.getState().ingest(connectionId, {
            type: 'error',
            threadId: request.conversation.id,
            message: err instanceof Error ? err.message : String(err),
          })
        })
      }
      return {
        creationId: request.creationId,
        threadId: request.conversation.id,
        projectPath: request.projectPath,
        title: request.projectName,
      }
    }

    const coordinator = createNewSessionCreationCoordinator({
      nextCreationId: () => `mobile-create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      now: Date.now,
      worktrees: {
        create: (request) => client.createWorktreeCreation(request),
        get: (request) => client.getWorktreeCreation(request),
        act: (request) => client.actOnWorktreeCreation(request),
        subscribe: (handler) => client.onWorktreeCreationProgress(handler),
      },
      storage: mobileNewSessionCreationStorage,
      parentCheckout: { create: createParentCheckout },
      onReady: (result) => {
        const readyState = coordinator.getState()
        const runtimeMode = readyState.intent?.provider.runtimeMode ?? 'sandbox'
        useChatStore.getState().setRuntimeMode(threadKey(connectionId, result.threadId), runtimeMode)
        navigation.replace('Thread', {
          connectionId,
          threadId: result.threadId,
          title: result.title,
          projectPath: result.projectPath,
          worktreePath: result.worktreePath,
          worktreeBranch: result.branch,
          worktreeId: result.worktreeId,
          creationId: result.creationId,
          isNew: true,
        })
      },
    })
    coordinatorRef.current = coordinator
    const unsubscribe = coordinator.subscribe(setCreationState)
    void coordinator.restore(connectionId, projectPath).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      unsubscribe()
      coordinator.dispose()
      if (coordinatorRef.current === coordinator) coordinatorRef.current = null
    }
  }, [connectionId, navigation, projectName, projectPath])

  const start = async () => {
    const coordinator = coordinatorRef.current
    if (!coordinator) {
      setError('Backend not connected yet.')
      return
    }
    setError(null)
    const threadId = `mob-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const message = firstMessage.trim()
    await coordinator.begin({
      connectionId,
      machineId: connectionId,
      projectPath,
      projectName,
      checkout: checkoutKind === 'worktree'
        ? {
            kind: 'worktree',
            baseRef: baseRef.trim() || 'HEAD',
            branchSeed: projectName,
            setupPolicy,
          }
        : { kind: 'parent-checkout' },
      conversation: { id: threadId, agentType },
      provider: {
        kind: provider,
        instanceId: selectedInstance?.id,
        model: model || undefined,
        runtimeMode: mode,
      },
      ...(message ? { firstMessage: message } : {}),
    })
  }

  const retry = async () => {
    setError(null)
    try {
      await coordinatorRef.current?.retry()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const startInProject = async () => {
    setError(null)
    try {
      await coordinatorRef.current?.startInProject()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const chooseSetup = async (action: 'choose_setup_run' | 'choose_setup_skip') => {
    setError(null)
    try {
      await coordinatorRef.current?.chooseSetup(action)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <KeyboardAvoidingView style={styles.screen} {...keyboardAvoidance(Platform.OS, headerHeight)}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.projectName}>{projectName}</Text>
        <Text style={styles.projectPath} numberOfLines={1} ellipsizeMode="middle">
          {projectPath}
        </Text>

        <Text style={styles.sectionLabel}>Workspace</Text>
        <View style={styles.providerList}>
          <Pressable
            disabled={activeWorktreeCreation}
            onPress={() => setCheckoutKind('parent-checkout')}
            style={[styles.providerRow, checkoutKind === 'parent-checkout' && styles.providerRowActive]}
          >
            <View style={styles.providerBody}>
              <Text style={[styles.providerLabel, checkoutKind === 'parent-checkout' && styles.providerLabelActive]}>
                Current checkout
              </Text>
              <Text style={styles.providerBlurb}>Start in the project folder as it is now</Text>
            </View>
            <View style={[styles.radio, checkoutKind === 'parent-checkout' && styles.radioActive]}>
              {checkoutKind === 'parent-checkout' && <View style={styles.radioDot} />}
            </View>
          </Pressable>
          {offerWorktreeCreation && (
            <Pressable
              disabled={activeWorktreeCreation}
              onPress={() => setCheckoutKind('worktree')}
              style={[styles.providerRow, checkoutKind === 'worktree' && styles.providerRowActive]}
            >
              <View style={styles.providerBody}>
                <Text style={[styles.providerLabel, checkoutKind === 'worktree' && styles.providerLabelActive]}>
                  New worktree
                </Text>
                <Text style={styles.providerBlurb}>Create an isolated checkout for this session</Text>
              </View>
              <View style={[styles.radio, checkoutKind === 'worktree' && styles.radioActive]}>
                {checkoutKind === 'worktree' && <View style={styles.radioDot} />}
              </View>
            </Pressable>
          )}
        </View>

        {checkoutKind === 'worktree' && (
          <>
            <Text style={styles.sectionLabel}>Base ref</Text>
            <TextInput
              style={styles.singleLineInput}
              value={baseRef}
              onChangeText={setBaseRef}
              editable={!activeWorktreeCreation}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="HEAD"
              placeholderTextColor={colors.textFaint}
            />
            <Text style={styles.sectionLabel}>Workspace setup</Text>
            <View style={styles.chipRow}>
              {SETUP_POLICIES.map((policy) => {
                const active = setupPolicy === policy.value
                return (
                  <Pressable
                    key={policy.value}
                    disabled={activeWorktreeCreation}
                    onPress={() => setSetupPolicy(policy.value)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{policy.label}</Text>
                  </Pressable>
                )
              })}
            </View>
          </>
        )}

        <Text style={styles.sectionLabel}>Agent</Text>
        <View style={styles.providerList}>
          {PROVIDERS.map((p) => {
            const active = provider === p.kind
            return (
              <Pressable
                key={p.kind}
                disabled={activeWorktreeCreation}
                onPress={() => setProvider(p.kind)}
                style={[styles.providerRow, active && styles.providerRowActive]}
              >
                <View style={styles.providerBody}>
                  <Text style={[styles.providerLabel, active && styles.providerLabelActive]}>{p.label}</Text>
                  <Text style={styles.providerBlurb}>{p.blurb}</Text>
                </View>
                <View style={[styles.radio, active && styles.radioActive]}>
                  {active && <View style={styles.radioDot} />}
                </View>
              </Pressable>
            )
          })}
        </View>

        {agentInstances.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>Profile</Text>
            <View style={styles.chipRow}>
              {agentInstances.map((inst) => {
                const active = inst.id === selectedInstance?.id
                return (
                  <Pressable
                    key={inst.id}
                    disabled={activeWorktreeCreation}
                    onPress={() => setInstanceId(inst.id)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <View style={[styles.instanceDot, { backgroundColor: inst.accentColor ?? colors.accent }]} />
                    <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                      {inst.displayName}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </>
        )}

        {models.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>Model</Text>
            <View style={styles.chipRow}>
              <Pressable
                disabled={activeWorktreeCreation}
                onPress={() => setModel('')}
                style={[styles.chip, model === '' && styles.chipActive]}
              >
                <Text style={[styles.chipText, model === '' && styles.chipTextActive]}>Default</Text>
              </Pressable>
              {models.map((m) => {
                const active = m.id === model
                return (
                  <Pressable
                    key={m.id}
                    disabled={activeWorktreeCreation}
                    onPress={() => setModel(m.id)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                      {m.label}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          </>
        )}

        <Text style={styles.sectionLabel}>Runtime mode</Text>
        <ModePicker value={mode} onChange={activeWorktreeCreation ? () => undefined : setMode} variant="row" />

        <Text style={styles.sectionLabel}>First message (optional)</Text>
        <TextInput
          style={styles.input}
          value={firstMessage}
          onChangeText={setFirstMessage}
          editable={!activeWorktreeCreation}
          placeholder="What should the agent do?"
          placeholderTextColor={colors.textFaint}
          multiline
        />
        <View style={styles.voiceRow}>
          {voiceNote ? <VoiceNoteBar note={voiceNote} /> : <View style={styles.voiceSpacer} />}
          {!activeWorktreeCreation && (
            <MicButton
              draft={firstMessage}
              onDraft={setFirstMessage}
              onNote={setVoiceNote}
              refine={{ connectionId, projectPath }}
            />
          )}
        </View>

        {activeWorktreeCreation && (
          <View style={styles.progressCard} accessibilityLiveRegion="polite">
            <View style={styles.progressHeading}>
              {(busy || creationState.status === 'ambiguous') && <ActivityIndicator size="small" color={colors.accent} />}
              <Text style={styles.progressLabel}>{creationActions.progressLabel}</Text>
            </View>
            {creationState.error && <Text style={styles.errorText}>{creationState.error}</Text>}
            {(creationActions.canRetry ||
              creationActions.canStartInProject ||
              creationActions.canChooseSetupRun ||
              creationActions.canChooseSetupSkip) && (
              <View style={styles.recoveryRow}>
                {creationActions.canChooseSetupRun && (
                  <Pressable style={styles.secondaryButton} onPress={() => void chooseSetup('choose_setup_run')}>
                    <Text style={styles.secondaryButtonLabel}>Run setup</Text>
                  </Pressable>
                )}
                {creationActions.canChooseSetupSkip && (
                  <Pressable style={styles.secondaryButton} onPress={() => void chooseSetup('choose_setup_skip')}>
                    <Text style={styles.secondaryButtonLabel}>Skip setup</Text>
                  </Pressable>
                )}
                {creationActions.canRetry && (
                  <Pressable style={styles.secondaryButton} onPress={() => void retry()}>
                    <Text style={styles.secondaryButtonLabel}>Retry</Text>
                  </Pressable>
                )}
                {creationActions.canStartInProject && (
                  <Pressable style={styles.secondaryButton} onPress={() => void startInProject()}>
                    <Text style={styles.secondaryButtonLabel}>Start in current checkout</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}

        {!activeWorktreeCreation && (
          <Pressable
            style={[styles.startButton, busy && styles.startButtonDisabled]}
            onPress={() => void start()}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator size="small" color="#08131f" />
            ) : (
              <Text style={styles.startLabel}>Start session</Text>
            )}
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: space.lg,
    gap: space.sm,
  },
  projectName: {
    ...type.heading,
    fontFamily: fonts.displayBold,
    color: colors.text,
  },
  projectPath: {
    ...type.mono,
    color: colors.textFaint,
    marginBottom: space.sm,
  },
  sectionLabel: {
    ...type.label,
    color: colors.textFaint,
    textTransform: 'uppercase',
    marginTop: space.md,
  },
  providerList: {
    gap: space.sm,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    minHeight: HIT,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  providerRowActive: {
    borderColor: colors.accent,
    backgroundColor: colors.accentWash,
  },
  providerBody: {
    flex: 1,
    gap: 2,
  },
  providerLabel: {
    ...type.heading,
    color: colors.text,
  },
  providerLabelActive: {
    color: colors.accent,
  },
  providerBlurb: {
    ...type.bodySm,
    color: colors.textDim,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.accentWash,
    borderColor: colors.accent,
  },
  chipText: {
    ...type.mono,
    color: colors.textDim,
    flexShrink: 1,
  },
  chipTextActive: {
    color: colors.accent,
  },
  instanceDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioActive: {
    borderColor: colors.accent,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  singleLineInput: {
    ...type.mono,
    minHeight: HIT,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
  },
  input: {
    ...type.body,
    minHeight: 88,
    maxHeight: 180,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    textAlignVertical: 'top',
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.sm,
  },
  voiceSpacer: {
    flex: 1,
  },
  progressCard: {
    marginTop: space.md,
    padding: space.md,
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  progressHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  progressLabel: {
    ...type.body,
    color: colors.text,
    flex: 1,
  },
  recoveryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  secondaryButton: {
    minHeight: HIT,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
  },
  secondaryButtonLabel: {
    ...type.label,
    color: colors.accent,
  },
  errorText: {
    ...type.bodySm,
    color: colors.red,
    marginTop: space.xs,
  },
  startButton: {
    marginTop: space.lg,
    minHeight: HIT + 4,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startButtonDisabled: {
    opacity: 0.6,
  },
  startLabel: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: '#08131f',
  },
})
