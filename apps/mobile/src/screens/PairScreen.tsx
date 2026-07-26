/**
 * Pair (or edit) a backend, in either flavour the connections store supports:
 *
 *   WebSocket - scan the QR from the desktop's Mobile Pairing settings, or type
 *               the ws:// URL + token manually. A successful scan just fills the
 *               manual fields; saving is always explicit.
 *   Google IAP - a work VM reached through tunnel.cloudproxy.app. No QR here: a
 *               pairing QR carries a ws:// URL, which an IAP target has none of.
 *
 * The kind is fixed once saved. Editing shows it as text rather than a control,
 * because swapping kinds mid-edit would mean rewriting every field anyway.
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
import { parsePairingUrl, useConnectionsStore, type ConnectionConfig } from '../stores/connections'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Pair'>
type Route = RouteProp<RootStackParamList, 'Pair'>

type Kind = ConnectionConfig['kind']

const KIND_LABEL: Record<Kind, string> = {
  ws: 'WebSocket',
  iap: 'Google IAP',
}

/** TcpHost's conventional port on a VM (the server's TCP_PORT). */
const DEFAULT_IAP_PORT = '8766'

export default function PairScreen() {
  const navigation = useNavigation<Nav>()
  const route = useRoute<Route>()
  const editId = route.params?.editId

  const editConfig = editId
    ? useConnectionsStore.getState().configs.find((c) => c.id === editId)
    : undefined

  const [kind, setKind] = useState<Kind>(editConfig?.kind ?? 'ws')
  const [label, setLabel] = useState(editConfig?.label ?? '')
  const [url, setUrl] = useState(editConfig?.kind === 'ws' ? editConfig.url : '')
  const [token, setToken] = useState(editConfig?.token ?? '')
  const [project, setProject] = useState(editConfig?.kind === 'iap' ? editConfig.project : '')
  const [zone, setZone] = useState(editConfig?.kind === 'iap' ? editConfig.zone : '')
  const [instance, setInstance] = useState(editConfig?.kind === 'iap' ? editConfig.instance : '')
  const [port, setPort] = useState(
    editConfig?.kind === 'iap' ? String(editConfig.port) : DEFAULT_IAP_PORT,
  )
  const [scanning, setScanning] = useState(!editConfig)

  const [permission, requestPermission] = useCameraPermissions()
  const scannedRef = useRef(false)

  useEffect(() => {
    // Only the ws flow uses the camera, so don't prompt for it in IAP mode.
    if (kind === 'ws') requestPermission()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind])

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

  const saveWs = () => {
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
    const saved = { label: label.trim(), url: parsed.url, token: parsed.token }
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

  const saveIap = () => {
    const trimmedProject = project.trim()
    const trimmedZone = zone.trim()
    const trimmedInstance = instance.trim()
    if (!trimmedProject) {
      Alert.alert('Project required', 'Enter the GCP project id, like prj-geoiq-decisioniq-in-prod.')
      return
    }
    if (!trimmedZone) {
      Alert.alert('Zone required', 'Enter the VM zone, like asia-south1-b.')
      return
    }
    if (!trimmedInstance) {
      Alert.alert('Instance required', 'Enter the VM instance name, like geoiq-ssg-dev-in.')
      return
    }
    const portNumber = Number(port.trim())
    if (!Number.isInteger(portNumber) || portNumber <= 0) {
      Alert.alert('Port required', `Enter the VM's TCP_PORT as a whole number, like ${DEFAULT_IAP_PORT}.`)
      return
    }

    const store = useConnectionsStore.getState()
    const trimmedToken = token.trim()
    const saved = {
      label: label.trim(),
      project: trimmedProject,
      zone: trimmedZone,
      instance: trimmedInstance,
      port: portNumber,
      token: trimmedToken || undefined,
    }
    if (editId) {
      store.updateConnection(editId, saved)
      // Re-dial so the edited target takes effect immediately.
      store.disconnect(editId)
      store.connect(editId)
    } else {
      const id = `c-${Date.now()}`
      store.addConnection({ id, kind: 'iap', ...saved })
      store.connect(id)
    }
    navigation.goBack()
  }

  const handleSave = () => {
    if (!label.trim()) {
      Alert.alert('Label required', 'Give this backend a name, like "MacBook" or "Dev VM".')
      return
    }
    if (kind === 'iap') saveIap()
    else saveWs()
  }

  const renderKindPicker = () => {
    if (editId) {
      return (
        <>
          <Text style={styles.fieldLabel}>Connection type</Text>
          <Text style={styles.fixedValue}>{KIND_LABEL[kind]}</Text>
          <Text style={styles.hint}>
            The type is fixed once saved. Remove this backend and add it again to switch.
          </Text>
        </>
      )
    }
    return (
      <View style={styles.segmented}>
        {(['ws', 'iap'] as const).map((option) => {
          const active = kind === option
          return (
            <Pressable
              key={option}
              onPress={() => setKind(option)}
              style={({ pressed }) => [
                styles.segment,
                active && styles.segmentActive,
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {KIND_LABEL[option]}
              </Text>
            </Pressable>
          )
        })}
      </View>
    )
  }

  const renderCameraArea = () => {
    if (kind !== 'ws' || !scanning) return null
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

  const renderWsFields = () => (
    <>
      <Pressable
        onPress={toggleScanning}
        style={({ pressed }) => [styles.secondaryButton, styles.scanButton, pressed && styles.pressed]}
      >
        <Text style={styles.secondaryButtonText}>{scanning ? 'Stop scanning' : 'Scan QR'}</Text>
      </Pressable>

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
    </>
  )

  const renderIapFields = () => (
    <>
      <Text style={styles.fieldLabel}>GCP project</Text>
      <TextInput
        style={styles.input}
        value={project}
        onChangeText={setProject}
        placeholder="prj-geoiq-decisioniq-in-prod"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>Zone</Text>
      <TextInput
        style={styles.input}
        value={zone}
        onChangeText={setZone}
        placeholder="asia-south1-b"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>Instance name</Text>
      <TextInput
        style={styles.input}
        value={instance}
        onChangeText={setInstance}
        placeholder="geoiq-ssg-dev-in"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.fieldLabel}>Port</Text>
      <TextInput
        style={styles.input}
        value={port}
        onChangeText={setPort}
        placeholder={DEFAULT_IAP_PORT}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="number-pad"
      />

      <Text style={styles.fieldLabel}>Backend token</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="SWITCHBOARD_TOKEN on that VM"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Text style={styles.hint}>
        IAP reaches a VM that exposes no inbound port, from any network, with your laptop closed.
      </Text>
      <Text style={styles.hint}>
        It needs a Google sign-in first - use the Account button on the Connections screen.
      </Text>
      <Text style={styles.hint}>
        On the VM, run the server with TCP_PORT set to the port above and SWITCHBOARD_TOKEN set to
        the token above.
      </Text>
      <Text style={styles.hint}>
        The VM also needs a firewall rule allowing 35.235.240.0/20 to that port, or the tunnel opens
        and then goes silent.
      </Text>
    </>
  )

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
        {renderKindPicker()}

        <Text style={styles.fieldLabel}>Label</Text>
        <TextInput
          style={styles.input}
          value={label}
          onChangeText={setLabel}
          placeholder={kind === 'iap' ? 'Dev VM' : 'MacBook'}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="words"
          autoCorrect={false}
        />

        {kind === 'iap' ? renderIapFields() : renderWsFields()}

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
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    overflow: 'hidden',
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
  },
  segmentActive: {
    backgroundColor: colors.accent,
  },
  segmentText: {
    color: colors.textDim,
    fontSize: 14,
    fontWeight: '600',
  },
  segmentTextActive: {
    color: colors.text,
  },
  fieldLabel: {
    color: colors.textDim,
    fontSize: 13,
    fontWeight: '600',
    marginTop: 12,
  },
  fixedValue: {
    color: colors.text,
    fontSize: 15,
    paddingVertical: 4,
  },
  hint: {
    color: colors.textFaint,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 6,
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
  scanButton: {
    marginTop: 12,
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
