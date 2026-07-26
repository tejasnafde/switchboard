/**
 * Pair (or edit) a backend. Scan the QR from the desktop's Mobile Pairing
 * settings, or type the ws:// URL + token manually. A successful scan just
 * fills the manual fields - saving is always explicit.
 */
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { RootStackParamList } from '../../App'
import { colors } from '../theme'
import { parsePairingUrl, useConnectionsStore } from '../stores/connections'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Pair'>
type Route = RouteProp<RootStackParamList, 'Pair'>

export default function PairScreen() {
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const editId = route.params?.editId

  const editConfig = editId
    ? useConnectionsStore.getState().configs.find((c) => c.id === editId)
    : undefined

  const [label, setLabel] = useState(editConfig?.label ?? '')
  const [url, setUrl] = useState(editConfig?.kind === 'ws' ? editConfig.url : '')
  const [token, setToken] = useState(editConfig?.token ?? '')
  const [scanning, setScanning] = useState(!editConfig)

  const [permission, requestPermission] = useCameraPermissions()
  const scannedRef = useRef(false)

  useEffect(() => {
    requestPermission()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleBarcode = (result: BarcodeScanningResult) => {
    if (scannedRef.current) return
    const parsed = parsePairingUrl(result.data)
    if (!parsed) return
    scannedRef.current = true
    setUrl(parsed.url)
    setToken(parsed.token ?? '')
    setScanning(false)
  }

  const toggleScanning = () => {
    if (!scanning) scannedRef.current = false
    setScanning((s) => !s)
  }

  const handleSave = () => {
    const trimmedLabel = label.trim()
    if (!trimmedLabel) {
      Alert.alert('Label required', 'Give this backend a name, like "MacBook" or "Dev VM".')
      return
    }
    const trimmedUrl = url.trim()
    const trimmedToken = token.trim()
    const candidate = trimmedToken
      ? `${trimmedUrl}${trimmedUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(trimmedToken)}`
      : trimmedUrl
    const parsed = parsePairingUrl(candidate)
    if (!parsed) {
      Alert.alert('Invalid URL', 'Expected a ws:// or wss:// URL, like ws://192.168.1.20:8765')
      return
    }

    const store = useConnectionsStore.getState()
    const saved = { label: trimmedLabel, url: parsed.url, token: parsed.token }
    if (editId) {
      store.updateConnection(editId, saved)
      // Re-dial so the edited url/token take effect immediately.
      store.disconnect(editId)
      store.connect(editId)
    } else {
      const id = `c-${Date.now()}`
      store.addConnection({ id, kind: 'ws', ...saved })
      store.connect(id)
    }
    navigation.goBack()
  }

  const renderCameraArea = () => {
    if (!scanning) return null
    if (!permission) return <View style={styles.cameraWrap} />
    if (!permission.granted) {
      return (
        <View style={[styles.cameraWrap, styles.cameraDenied]}>
          <Text style={styles.deniedTitle}>Camera access denied</Text>
          <Text style={styles.deniedBody}>
            Enter the connection details manually below, or grant camera access to scan the pairing
            QR.
          </Text>
          {permission.canAskAgain && (
            <Pressable
              onPress={() => requestPermission()}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
            >
              <Text style={styles.secondaryButtonText}>Grant access</Text>
            </Pressable>
          )}
        </View>
      )
    }
    return (
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarcode}
        />
        <View style={styles.scanHint}>
          <Text style={styles.scanHintText}>Point at the pairing QR</Text>
        </View>
      </View>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {renderCameraArea()}
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.form}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable
          onPress={toggleScanning}
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.secondaryButtonText}>{scanning ? 'Stop scanning' : 'Scan QR'}</Text>
        </Pressable>

        <Text style={styles.fieldLabel}>Label</Text>
        <TextInput
          style={styles.input}
          value={label}
          onChangeText={setLabel}
          placeholder="MacBook"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="words"
          autoCorrect={false}
        />

        <Text style={styles.fieldLabel}>URL</Text>
        <TextInput
          style={styles.input}
          value={url}
          onChangeText={setUrl}
          placeholder="ws://192.168.1.20:8765"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={styles.fieldLabel}>Token (optional)</Text>
        <TextInput
          style={styles.input}
          value={token}
          onChangeText={setToken}
          placeholder="Pairing token"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable
          onPress={handleSave}
          style={({ pressed }) => [styles.saveButton, pressed && styles.pressed]}
        >
          <Text style={styles.saveButtonText}>{editId ? 'Save changes' : 'Add backend'}</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  cameraWrap: {
    height: '45%',
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  cameraDenied: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  deniedTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  deniedBody: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 16,
  },
  scanHint: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: 'rgba(13, 15, 18, 0.75)',
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  scanHintText: {
    color: colors.text,
    fontSize: 13,
  },
  form: {
    padding: 16,
    gap: 6,
  },
  fieldLabel: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
  },
  input: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    color: colors.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  secondaryButtonText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 8,
    marginTop: 24,
    paddingVertical: 12,
  },
  saveButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.6,
  },
})
