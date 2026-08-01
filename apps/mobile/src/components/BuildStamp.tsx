/**
 * Which build is running, shown in the UI.
 *
 * Reads expo-updates at render time rather than through the store, because it
 * never changes during a session and nothing else needs it.
 */
import React, { memo, useMemo } from 'react'
import { StyleSheet, Text } from 'react-native'
import * as Application from 'expo-application'
import * as Updates from 'expo-updates'
import { formatBuildStamp } from '../lib/buildInfo'
import { colors, space, type } from '../theme'

export const BuildStamp = memo(function BuildStamp() {
  const stamp = useMemo(
    () =>
      formatBuildStamp({
        version: Application.nativeApplicationVersion ?? null,
        updateId: Updates.updateId ?? null,
        channel: Updates.channel ?? null,
        isEmbedded: Updates.isEmbeddedLaunch ?? false,
      }),
    [],
  )
  return (
    <Text style={styles.stamp} selectable>
      {stamp}
    </Text>
  )
})

const styles = StyleSheet.create({
  stamp: {
    color: colors.textFaint,
    ...type.monoSm,
    textAlign: 'center',
    paddingVertical: space.sm,
  },
})
