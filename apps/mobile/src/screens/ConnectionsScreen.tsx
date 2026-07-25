/**
 * Saved backends list. Each row shows a status dot + label + url; tap drills
 * into the backend's projects, long-press opens row actions. Connects every
 * saved config on mount (the store guards double-connect).
 */
import { useEffect, useLayoutEffect } from 'react'
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../App'
import { colors, statusColor } from '../theme'
import { useConnectionsStore, type ConnectionConfig } from '../stores/connections'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Connections'>

export default function ConnectionsScreen() {
  const navigation = useNavigation<Nav>()
  const configs = useConnectionsStore((s) => s.configs)
  const status = useConnectionsStore((s) => s.status)

  useEffect(() => {
    const store = useConnectionsStore.getState()
    for (const config of store.configs) store.connect(config.id)
  }, [])

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <Pressable
          onPress={() => navigation.navigate('Pair')}
          hitSlop={12}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}
        >
          <Text style={styles.addButtonText}>+</Text>
        </Pressable>
      ),
    })
  }, [navigation])

  const showRowActions = (config: ConnectionConfig) => {
    const store = useConnectionsStore.getState()
    const current = store.status[config.id] ?? 'disconnected'
    const isLive = current === 'connected' || current === 'connecting'
    Alert.alert(config.label, config.url, [
      {
        text: 'Edit',
        onPress: () => navigation.navigate('Pair', { editId: config.id }),
      },
      {
        text: isLive ? 'Disconnect' : 'Connect',
        onPress: () => (isLive ? store.disconnect(config.id) : store.connect(config.id)),
      },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          Alert.alert('Remove backend?', `"${config.label}" will be forgotten on this device.`, [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Remove',
              style: 'destructive',
              onPress: () => useConnectionsStore.getState().removeConnection(config.id),
            },
          ]),
      },
      { text: 'Cancel', style: 'cancel' },
    ])
  }

  const renderRow = ({ item }: { item: ConnectionConfig }) => {
    const dot = statusColor[status[item.id] ?? 'disconnected']
    return (
      <Pressable
        onPress={() => navigation.navigate('Projects', { connectionId: item.id, label: item.label })}
        onLongPress={() => showRowActions(item)}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <View style={styles.rowBody}>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {item.label}
          </Text>
          <Text style={styles.rowUrl} numberOfLines={1}>
            {item.url}
          </Text>
        </View>
      </Pressable>
    )
  }

  if (configs.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyTitle}>No backends paired</Text>
        <Text style={styles.emptyBody}>
          Run npm run server on your Mac or VM, then Settings → Mobile Pairing shows a QR you can
          scan here.
        </Text>
        <Pressable
          onPress={() => navigation.navigate('Pair')}
          style={({ pressed }) => [styles.pairButton, pressed && styles.pressed]}
        >
          <Text style={styles.pairButtonText}>Pair a backend</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <FlatList
      data={configs}
      keyExtractor={(item) => item.id}
      renderItem={renderRow}
      contentContainerStyle={styles.list}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
    />
  )
}

const styles = StyleSheet.create({
  list: {
    paddingVertical: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: colors.bg,
  },
  pressed: {
    opacity: 0.6,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 12,
  },
  rowBody: {
    flex: 1,
  },
  rowLabel: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  rowUrl: {
    color: colors.textDim,
    fontSize: 13,
    marginTop: 2,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 38,
  },
  addButton: {
    paddingHorizontal: 4,
  },
  addButtonText: {
    color: colors.accent,
    fontSize: 26,
    fontWeight: '400',
    lineHeight: 30,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptyBody: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 24,
  },
  pairButton: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 20,
    paddingVertical: 11,
  },
  pairButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
})
