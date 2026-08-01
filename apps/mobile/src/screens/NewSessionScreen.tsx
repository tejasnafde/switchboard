/**
 * Start a fresh agent session in a project: pick a provider, OAuth profile
 * (provider instance), model + runtime mode, optionally type the first message,
 * then create the conversation row and spawn the provider session on the
 * backend. Mirrors the desktop's createConversation -> startSession -> sendTurn
 * launch flow (cardLaunch.ts).
 */
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { NativeStackScreenProps } from '@react-navigation/native-stack'
import type { ProviderKind, RuntimeMode } from '@shared/provider-events'
import type { AgentType, ProviderInstance } from '@shared/types'
import { agentTypeFor, profilesFor } from '../lib/profiles'
import { modelsForAgent } from '@shared/models'
import { generateTitle } from '@shared/auto-title'
import { createLogger } from '@shared/logger'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { getClient } from '../stores/connections'
import { useChatStore, threadKey } from '../stores/chat'
import { ModePicker } from '../components/ModePicker'
import { MicButton, VoiceNoteBar, type VoiceNote } from '../components/MicButton'

const log = createLogger('screen:new-session')

type Props = NativeStackScreenProps<RootStackParamList, 'NewSession'>

const PROVIDERS: { kind: ProviderKind; label: string; blurb: string }[] = [
  { kind: 'claude', label: 'Claude Code', blurb: 'Anthropic agent SDK, resumable sessions' },
  { kind: 'codex', label: 'Codex', blurb: 'OpenAI codex app-server' },
  { kind: 'opencode', label: 'OpenCode', blurb: 'Agent Client Protocol' },
]

export default function NewSessionScreen({ route, navigation }: Props) {
  const { connectionId, projectPath, projectName } = route.params
  const [provider, setProvider] = useState<ProviderKind>('claude')
  const [mode, setMode] = useState<RuntimeMode>('sandbox')
  const [firstMessage, setFirstMessage] = useState('')
  const [voiceNote, setVoiceNote] = useState<VoiceNote | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [instances, setInstances] = useState<ProviderInstance[]>([])
  const [instanceId, setInstanceId] = useState<string | undefined>(undefined)
  const [model, setModel] = useState('')

  const agentType = agentTypeFor(provider)

  // Profiles are listed once per connection - the set is per-backend, not
  // per-agent, so switching the provider row just re-filters below.
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

  // Shared with the thread-screen picker so both order profiles identically.
  const agentInstances = useMemo(() => profilesFor(instances, provider), [instances, provider])

  // Falls back to the first (default) entry so the chip row always shows what
  // the backend will actually resolve.
  const selectedInstance = agentInstances.find((i) => i.id === instanceId) ?? agentInstances[0]

  // Pre-session model list is static: provider:list-models is bound to a
  // STARTED thread, so there is nothing live to ask yet. The thread screen
  // swaps in the account's real list once the session is up.
  const models = useMemo(() => modelsForAgent(agentType), [agentType])

  // A profile / model from the previous provider is meaningless for the new one.
  useEffect(() => {
    setInstanceId(undefined)
    setModel('')
  }, [agentType])

  const start = async () => {
    const client = getClient(connectionId)
    if (!client) {
      setError('Backend not connected yet.')
      return
    }
    setBusy(true)
    setError(null)
    const threadId = `mob-${Date.now().toString(36)}`
    const message = firstMessage.trim()
    try {
      await client.createConversation({
        id: threadId,
        projectPath,
        agentType,
        title: message ? generateTitle(message) : undefined,
      })
      // Failure rejects (no { ok } envelope) - the catch below shows it.
      // instanceId / model left undefined means "let the backend decide":
      // resolveProviderInstance falls back to `<agent-type>-default`.
      await client.startSession({
        threadId,
        provider,
        cwd: projectPath,
        runtimeMode: mode,
        instanceId: selectedInstance?.id,
        model: model || undefined,
      })

      const key = threadKey(connectionId, threadId)
      useChatStore.getState().setRuntimeMode(key, mode)
      if (message) {
        useChatStore.getState().addUserMessage(key, message)
        client.sendTurn(threadId, message, mode).catch((err) => {
          useChatStore.getState().ingest(connectionId, {
            type: 'error',
            threadId,
            message: err instanceof Error ? err.message : String(err),
          })
        })
      }
      navigation.replace('Thread', {
        connectionId,
        threadId,
        title: projectName,
        projectPath,
        isNew: true,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.projectName}>{projectName}</Text>
      <Text style={styles.projectPath} numberOfLines={1} ellipsizeMode="middle">
        {projectPath}
      </Text>

      <Text style={styles.sectionLabel}>Agent</Text>
      <View style={styles.providerList}>
        {PROVIDERS.map((p) => {
          const active = provider === p.kind
          return (
            <Pressable
              key={p.kind}
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
                  onPress={() => setInstanceId(inst.id)}
                  style={[styles.chip, active && styles.chipActive]}
                >
                  <View
                    style={[styles.instanceDot, { backgroundColor: inst.accentColor ?? colors.accent }]}
                  />
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
      <ModePicker value={mode} onChange={setMode} variant="row" />

      <Text style={styles.sectionLabel}>First message (optional)</Text>
      <TextInput
        style={styles.input}
        value={firstMessage}
        onChangeText={setFirstMessage}
        placeholder="What should the agent do?"
        placeholderTextColor={colors.textFaint}
        multiline
      />
      <View style={styles.voiceRow}>
        {voiceNote ? <VoiceNoteBar note={voiceNote} /> : <View style={styles.voiceSpacer} />}
        <MicButton draft={firstMessage} onDraft={setFirstMessage} onNote={setVoiceNote} />
      </View>

      {error && <Text style={styles.errorText}>{error}</Text>}

      <Pressable style={[styles.startButton, busy && styles.startButtonDisabled]} onPress={() => void start()} disabled={busy}>
        {busy ? (
          <ActivityIndicator size="small" color="#08131f" />
        ) : (
          <Text style={styles.startLabel}>Start session</Text>
        )}
      </Pressable>
    </ScrollView>
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
