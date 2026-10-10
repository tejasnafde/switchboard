import React from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import { colors } from '../theme'

export function ThreadWaitStatus({ label, error = false }: { label: string; error?: boolean }) {
  return (
    <View
      accessibilityRole={error ? 'alert' : 'summary'}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 }}
    >
      {!error && <ActivityIndicator size="small" color={colors.textDim} />}
      <Text style={{ flex: 1, color: colors.textDim }}>{label}</Text>
    </View>
  )
}
