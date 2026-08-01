/**
 * Slash-command list above the composer. Grouped by source so an agent skill is
 * never mistaken for one of Switchboard's own commands.
 */
import React, { memo } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SlashCommand } from '../lib/slash'
import { colors, fonts, radius, space, type } from '../theme'

const SOURCE_LABEL: Record<SlashCommand['source'], string> = {
  switchboard: 'SWITCHBOARD',
  'claude-code': 'CLAUDE CODE',
  codex: 'CODEX',
  opencode: 'OPENCODE',
}

export const SlashMenu = memo(function SlashMenu({
  commands,
  onPick,
}: {
  commands: SlashCommand[]
  onPick: (command: SlashCommand) => void
}) {
  if (commands.length === 0) return null

  let lastSource: SlashCommand['source'] | null = null

  return (
    <View style={styles.sheet}>
      <ScrollView keyboardShouldPersistTaps="always" style={styles.list}>
        {commands.map((cmd) => {
          const header = cmd.source !== lastSource ? SOURCE_LABEL[cmd.source] : null
          lastSource = cmd.source
          return (
            <View key={`${cmd.source}-${cmd.name}`}>
              {header !== null && <Text style={styles.group}>{header}</Text>}
              <Pressable
                onPress={() => onPick(cmd)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <Text style={styles.name}>
                  /{cmd.name}
                  {cmd.argumentHint ? <Text style={styles.hint}> {cmd.argumentHint}</Text> : null}
                </Text>
                {cmd.description.length > 0 && (
                  <Text style={styles.desc} numberOfLines={1}>
                    {cmd.description}
                  </Text>
                )}
              </Pressable>
            </View>
          )
        })}
      </ScrollView>
    </View>
  )
})

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    marginBottom: space.sm,
    overflow: 'hidden',
  },
  // Capped so the menu never swallows the feed on a small screen.
  list: { maxHeight: 240 },
  group: {
    color: colors.textFaint,
    ...type.label,
    paddingHorizontal: space.md,
    paddingTop: space.sm,
    paddingBottom: 2,
  },
  row: { paddingHorizontal: space.md, paddingVertical: space.sm },
  rowPressed: { backgroundColor: colors.surfaceRaised },
  name: { color: colors.text, fontFamily: fonts.mono, fontSize: 13 },
  hint: { color: colors.textFaint },
  desc: { color: colors.textDim, ...type.bodySm, marginTop: 1 },
})
