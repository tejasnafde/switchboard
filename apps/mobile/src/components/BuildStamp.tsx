/**
 * Which build is running, shown in the UI.
 *
 * Reads expo-updates at render time rather than through the store, because it
 * never changes during a session and nothing else needs it.
 */
import React, { memo } from 'react'
import { StyleSheet, Text } from 'react-native'
import * as Application from 'expo-application'
import * as Updates from 'expo-updates'
import { formatBuildStamp } from '../lib/buildInfo'
import { colors, space, type } from '../theme'

// Module constants, read once. These cannot change during a session, so there
// is nothing for a hook to track.
const STAMP = formatBuildStamp({
  version: Application.nativeApplicationVersion,
  updateId: Updates.updateId,
  channel: Updates.channel,
  isEmbedded: Updates.isEmbeddedLaunch,
  isEmergencyLaunch: Updates.isEmergencyLaunch,
})

export const BuildStamp = memo(function BuildStamp() {
  const stamp = STAMP
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
