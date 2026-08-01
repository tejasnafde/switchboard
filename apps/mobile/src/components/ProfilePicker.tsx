/**
 * Switch the agent, or the OAuth profile within an agent, on a LIVE thread.
 *
 * This is the "my 5-hour limit just ran out" control: pick another profile and
 * carry on in the same conversation. The new-session form has the same choice,
 * but before this the phone could not change either once a chat existed.
 */
import React, { memo, useMemo } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { ProviderKind } from '@shared/provider-events'
import type { ProviderInstance } from '@shared/types'
import { AGENTS, profilesFor } from '../lib/profiles'
import { colors, fonts, radius, space, type, HIT } from '../theme'

export const ProfilePicker = memo(function ProfilePicker({
  visible,
  instances,
  provider,
  instanceId,
  busy,
  onPick,
  onClose,
}: {
  visible: boolean
  instances: ProviderInstance[]
  provider: ProviderKind
  instanceId?: string
  busy: boolean
  onPick: (provider: ProviderKind, instanceId?: string) => void
  onClose: () => void
}) {
  const byAgent = useMemo(
    () => AGENTS.map((a) => ({ ...a, profiles: profilesFor(instances, a.kind) })),
    [instances],
  )

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.title}>Agent and profile</Text>
          <Text style={styles.note}>
            Switching restarts this session on the new credentials. The conversation is kept.
          </Text>

          <ScrollView style={styles.list}>
            {byAgent.map((agent) => (
              <View key={agent.kind} style={styles.group}>
                <Text style={styles.groupLabel}>{agent.label.toUpperCase()}</Text>

                {agent.profiles.length === 0 ? (
                  <Text style={styles.empty}>No profiles configured on this backend</Text>
                ) : (
                  agent.profiles.map((p) => {
                    const active = agent.kind === provider && (instanceId ?? '') === p.id
                    return (
                      <Pressable
                        key={p.id}
                        disabled={busy}
                        onPress={() => onPick(agent.kind, p.id)}
                        style={({ pressed }) => [
                          styles.row,
                          active && styles.rowActive,
                          (pressed || busy) && styles.rowPressed,
                        ]}
                      >
                        {/* The accent the desktop assigns this profile, so the
                            same credentials look the same on both clients. */}
                        <View
                          style={[styles.dot, { backgroundColor: p.accentColor || colors.textFaint }]}
                        />
                        <Text style={[styles.rowText, active && styles.rowTextActive]} numberOfLines={1}>
                          {p.displayName}
                        </Text>
                        {active && <Text style={styles.check}>current</Text>}
                      </Pressable>
                    )
                  })
                )}
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
})

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    maxHeight: '75%',
  },
  title: { color: colors.text, ...type.heading },
  note: { color: colors.textDim, ...type.bodySm, marginTop: space.xs, marginBottom: space.md },
  list: { flexGrow: 0 },
  group: { marginBottom: space.md },
  groupLabel: { color: colors.textFaint, ...type.label, marginBottom: space.xs },
  empty: { color: colors.textFaint, ...type.bodySm, paddingVertical: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
  },
  rowActive: { backgroundColor: colors.surfaceRaised },
  rowPressed: { opacity: 0.6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowText: { color: colors.text, fontFamily: fonts.display, fontSize: 15, flex: 1 },
  rowTextActive: { color: colors.accent },
  check: { color: colors.textFaint, ...type.monoSm },
})
