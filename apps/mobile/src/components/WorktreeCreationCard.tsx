import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { MobileNewSessionCreationActions, WorktreeActAction } from '../lib/new-session-creation'
import { colors, radius, space, type, HIT } from '../theme'

interface Props {
  actions: MobileNewSessionCreationActions
  error?: string
  spinning: boolean
  onAct(action: WorktreeActAction): void
  onRetry(): void
  onCheckStatus(): void
  onStartInProject(): void
}

/** New-session worktree progress and the recovery actions the backend offers. */
export function WorktreeCreationCard({
  actions,
  error,
  spinning,
  onAct,
  onRetry,
  onCheckStatus,
  onStartInProject,
}: Props) {
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.heading}>
        {spinning && <ActivityIndicator size="small" color={colors.accent} />}
        <Text style={styles.label}>{actions.progressLabel}</Text>
      </View>
      {actions.correlation && <Text style={styles.correlation}>{actions.correlation}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        {actions.canChooseSetupRun && <RecoveryButton label="Run setup" onPress={() => onAct('choose_setup_run')} />}
        {actions.canChooseSetupSkip && <RecoveryButton label="Skip setup" onPress={() => onAct('choose_setup_skip')} />}
        {actions.canRetry && <RecoveryButton label="Retry" onPress={onRetry} />}
        {actions.canCheckStatus && <RecoveryButton label="Check status" onPress={onCheckStatus} />}
        {actions.canStartInProject && <RecoveryButton label="Start in current checkout" onPress={onStartInProject} />}
        {actions.canRetain && <RecoveryButton label="Keep worktree" onPress={() => onAct('retain')} />}
        {actions.canRemove && <RecoveryButton label="Remove worktree" onPress={() => onAct('remove')} />}
        {actions.canCancel && <RecoveryButton label="Cancel worktree creation" onPress={() => onAct('cancel')} />}
      </View>
    </View>
  )
}

function RecoveryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.button} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    marginTop: space.md,
    padding: space.md,
    gap: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  label: {
    ...type.body,
    color: colors.text,
    flex: 1,
  },
  correlation: {
    ...type.monoSm,
    color: colors.textDim,
  },
  error: {
    ...type.bodySm,
    color: colors.red,
    marginTop: space.xs,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  button: {
    minHeight: HIT,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
  },
  buttonLabel: {
    ...type.label,
    color: colors.accent,
  },
})
