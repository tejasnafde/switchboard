import { ActivityIndicator, Text, View } from 'react-native'
import { colors } from '../theme'

export function HistoryPageStatus({ loading }: { loading: boolean }) {
  if (!loading) return null
  return (
    <View style={{ padding: 12, alignItems: 'center', gap: 4 }}>
      <ActivityIndicator size="small" color={colors.textDim} />
      <Text style={{ color: colors.textDim, fontSize: 12 }}>Loading older messages</Text>
    </View>
  )
}
