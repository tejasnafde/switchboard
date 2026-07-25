/**
 * Start a fresh agent session in a project: pick a provider + runtime mode,
 * optionally type the first message, then create the conversation row and
 * spawn the provider session on the backend. Mirrors the desktop's
 * createConversation -> startSession -> sendTurn launch flow (cardLaunch.ts).
 */
import { useState } from 'react'
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
import type { AgentType } from '@shared/types'
import { generateTitle } from '@shared/auto-title'
import type { RootStackParamList } from '../../App'
import { colors } from '../theme'
import { getClient } from '../stores/connections'
import { useChatStore, threadKey } from '../stores/chat'
import { ModePicker } from '../components/ModePicker'

type Props = NativeStackScreenProps<RootStackParamList, 'NewSession'>

const PROVIDERS: { kind: ProviderKind; label: string; blurb: string }[] = [
  { kind: 'claude', label: 'Claude Code', blurb: 'Anthropic agent SDK, resumable sessions' },
  { kind: 'codex', label: 'Codex', blurb: 'OpenAI codex app-server' },
  { kind: 'opencode', label: 'OpenCode', blurb: 'Agent Client Protocol' },
]

/** DB agent_type for a provider kind (CreateConversationParams.agentType). */
function agentTypeFor(kind: ProviderKind): AgentType {
  return kind === 'claude' ? 'claude-code' : kind
}

export default function NewSessionScreen({ route, navigation }: Props) {
  const { connectionId, projectPath, projectName } = route.params
  const [provider, setProvider] = useState<ProviderKind>('claude')
  const [mode, setMode] = useState<RuntimeMode>('sandbox')
  const [firstMessage, setFirstMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        agentType: agentTypeFor(provider),
        title: message ? generateTitle(message) : undefined,
      })
      // Failure rejects (no { ok } envelope) - the catch below shows it.
      await client.startSession({
        threadId,
        provider,
        cwd: projectPath,
        runtimeMode: mode,
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

      <Text style={styles.sectionLabel}>Runtime mode</Text>
      <ModePicker value={mode} onChange={setMode} />

      <Text style={styles.sectionLabel}>First message (optional)</Text>
      <TextInput
        style={styles.input}
        value={firstMessage}
        onChangeText={setFirstMessage}
        placeholder="What should the agent do?"
        placeholderTextColor={colors.textFaint}
        multiline
      />

      {error && <Text style={styles.errorText}>{error}</Text>}

      <Pressable style={[styles.startButton, busy && styles.startButtonDisabled]} onPress={() => void start()} disabled={busy}>
        {busy ? (
          <ActivityIndicator size="small" color="#fff" />
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
    padding: 16,
    gap: 8,
  },
  projectName: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  projectPath: {
    color: colors.textFaint,
    fontSize: 12,
    marginBottom: 8,
  },
  sectionLabel: {
    color: colors.textDim,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: 12,
  },
  providerList: {
    gap: 8,
  },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  providerRowActive: {
    borderColor: colors.accent,
    backgroundColor: 'rgba(79, 142, 247, 0.08)',
  },
  providerBody: {
    flex: 1,
    gap: 2,
  },
  providerLabel: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  providerLabelActive: {
    color: colors.accent,
  },
  providerBlurb: {
    color: colors.textDim,
    fontSize: 12,
  },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
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
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  input: {
    minHeight: 88,
    maxHeight: 180,
    padding: 12,
    borderRadius: 10,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  errorText: {
    color: colors.red,
    fontSize: 13,
    marginTop: 4,
  },
  startButton: {
    marginTop: 16,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  startButtonDisabled: {
    opacity: 0.6,
  },
  startLabel: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
})
