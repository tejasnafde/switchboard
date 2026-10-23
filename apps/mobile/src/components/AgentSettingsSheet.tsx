/**
 * What the composer's "model · mode" chip opens: the model, the agent and
 * profile, the chat's usage, its workspace (branch and checkout), the runtime
 * mode, and archiving the chat. Model and profile have their own pickers,
 * which open once this sheet is gone (`onDismiss`).
 */
import React from 'react'
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import type { RuntimeMode } from '@shared/provider-events'
import type { GitContextPresentation } from '../lib/git-context'
import { RUNTIME_MODE_LABEL } from '../lib/thread-chrome'
import { chat, colors, radius, space, type } from '../theme'

const MODES = Object.keys(RUNTIME_MODE_LABEL) as RuntimeMode[]

function Row({
  label,
  value,
  onPress,
  disabled,
  busy,
  testID,
}: {
  label: string
  value: string
  onPress?: () => void
  disabled?: boolean
  busy?: boolean
  testID?: string
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityLabel={`${label}: ${value}`}
      accessibilityState={{ disabled: Boolean(disabled) }}
      testID={testID}
      style={({ pressed }) => [styles.row, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
      {busy ? (
        <ActivityIndicator size="small" color={colors.textDim} />
      ) : (
        onPress && <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
      )}
    </Pressable>
  )
}

function Problem({
  message,
  detail,
  tone,
  onRetry,
}: {
  message: string
  detail: string
  tone: 'warning' | 'error'
  onRetry?: () => void
}) {
  return (
    <View style={styles.problem} accessibilityLabel={`${message}: ${detail}`}>
      <View style={styles.rowText}>
        <Text style={[styles.problemText, { color: tone === 'error' ? colors.red : colors.amber }]}>{message}</Text>
        <Text style={styles.rowValue}>{detail}</Text>
      </View>
      {onRetry && (
        <Pressable onPress={onRetry} accessibilityRole="button" accessibilityLabel="Retry" hitSlop={8}>
          <Text style={styles.retry}>Retry</Text>
        </Pressable>
      )}
    </View>
  )
}

function confirmArchive(onArchive: () => void) {
  Alert.alert(
    'Archive this conversation?',
    'It will leave active lists, but its history and local cached copy will be kept.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Archive', style: 'destructive', onPress: onArchive },
    ],
  )
}

export function AgentSettingsSheet({
  visible,
  modelLabel,
  profileLabel,
  profileBusy,
  mode,
  usage,
  gitContext,
  archiving,
  archiveError,
  archiveEnabled,
  onMode,
  onOpenModel,
  onOpenProfile,
  onRefreshGitContext,
  onArchive,
  onClose,
  onDismiss,
}: {
  visible: boolean
  /** Null when the agent reports no models to pick from. */
  modelLabel: string | null
  /** Null when the backend has no profiles to switch between. */
  profileLabel: string | null
  profileBusy: boolean
  mode: RuntimeMode
  usage: string | null
  gitContext: GitContextPresentation
  archiving: boolean
  archiveError: string | null
  archiveEnabled: boolean
  onMode: (mode: RuntimeMode) => void
  onOpenModel: () => void
  onOpenProfile: () => void
  onRefreshGitContext: () => void
  /** Runs after the user confirms. */
  onArchive: () => void
  onClose: () => void
  onDismiss: () => void
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={onDismiss}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close agent settings">
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()} testID="agent-settings-sheet">
          <View style={styles.handle} />
          <Text style={styles.heading} accessibilityRole="header">
            Agent settings
          </Text>
          <ScrollView>
            {modelLabel !== null && <Row label="Model" value={modelLabel} onPress={onOpenModel} />}
            {profileLabel !== null && (
              <Row label="Agent and profile" value={profileLabel} onPress={onOpenProfile} disabled={profileBusy} />
            )}
            <Row label="Usage" value={usage ?? 'Nothing reported yet'} testID="usage-row" />
            <Text style={styles.section}>Workspace</Text>
            <Row
              label={gitContext.branchLabel}
              value={
                `${gitContext.checkoutLabel} · ${gitContext.checkoutPath}` +
                (gitContext.parentProjectPath ? `\nParent · ${gitContext.parentProjectPath}` : '')
              }
              busy={gitContext.loading}
            />
            {gitContext.error !== null && (
              <Problem
                message="Could not refresh branch"
                detail={gitContext.error}
                tone="warning"
                onRetry={onRefreshGitContext}
              />
            )}
            <Text style={styles.section}>Runtime mode</Text>
            {MODES.map((m) => {
              const active = m === mode
              return (
                <Pressable
                  key={m}
                  onPress={() => onMode(m)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Runtime mode: ${RUNTIME_MODE_LABEL[m]}`}
                  style={({ pressed }) => [styles.modeRow, pressed && styles.pressed]}
                >
                  <Text style={[styles.modeText, active && styles.modeTextOn]}>{RUNTIME_MODE_LABEL[m]}</Text>
                  {active && <Ionicons name="checkmark" size={16} color={colors.accent} />}
                </Pressable>
              )
            })}
            <Text style={styles.section}>Conversation</Text>
            <Row
              label={archiving ? 'Archiving conversation' : 'Archive conversation'}
              value="Remove it from active lists without deleting its history."
              onPress={() => confirmArchive(onArchive)}
              disabled={!archiveEnabled}
              busy={archiving}
            />
            {archiveError !== null && (
              <Problem message="Could not archive conversation" detail={archiveError} tone="error" />
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surfaceRaised,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: space.sm,
    paddingBottom: space.xl,
    maxHeight: '85%',
  },
  handle: {
    alignSelf: 'center',
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textFaint,
    marginTop: space.sm,
    marginBottom: 18,
  },
  heading: { color: colors.text, ...type.heading, paddingHorizontal: space.xl, paddingBottom: space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: chat.sheetRow,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { color: colors.text, fontSize: 15, lineHeight: 20 },
  rowValue: { color: colors.textDim, ...type.meta },
  problem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
  },
  problemText: { fontSize: 14, lineHeight: 20 },
  retry: { color: colors.accent, fontSize: 15 },
  section: {
    color: colors.textDim,
    ...type.meta,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.xs,
  },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: chat.target,
    marginHorizontal: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  modeText: { color: colors.text, fontSize: 15 },
  modeTextOn: { color: colors.accent },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.5 },
})
