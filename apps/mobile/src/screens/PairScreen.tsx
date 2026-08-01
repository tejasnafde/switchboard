/**
 * Add a machine. The happy path is scan-and-done: the camera IS the screen, and a
 * successful scan saves and connects without a single field typed. The name
 * defaults to the host, so nothing has to be filled in at all.
 *
 * Manual entry still exists, because a QR is not always to hand, but it lives
 * behind a disclosure. A wall of inputs was the previous shape and it made the
 * common case feel like configuration.
 *
 * IAP has no QR to scan (a pairing QR carries a ws:// URL, which an IAP target
 * does not have), so its primary surface is the list discovered from a desktop's
 * ~/.ssh/config. When that list is empty the screen says WHY, because the usual
 * reason is being paired only to a headless server - which has no ssh config and
 * therefore never registers the machine handlers.
 */
import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
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
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import type { SshIapTarget } from '@shared/machines'
import { createLogger } from '@shared/logger'
import type { RootStackParamList } from '../../App'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import {
  getClient,
  parsePairingUrl,
  useConnectionsStore,
  type ConnectionConfig,
} from '../stores/connections'

const log = createLogger('screen:pair')

type Nav = NativeStackNavigationProp<RootStackParamList, 'Pair'>
type Kind = ConnectionConfig['kind']

const DEFAULT_IAP_PORT = '8766'

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  numeric,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  numeric?: boolean
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, mono && styles.inputMono]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={numeric ? 'number-pad' : 'default'}
      />
    </View>
  )
}

export default function PairScreen() {
  const navigation = useNavigation<Nav>()
  const route = useRoute<RouteProp<RootStackParamList, 'Pair'>>()
  const editId = route.params?.editId
  const editConfig = editId
    ? useConnectionsStore.getState().configs.find((c) => c.id === editId)
    : undefined

  const [kind, setKind] = useState<Kind>(editConfig?.kind ?? 'ws')
  // Editing cannot be done by scanning, so a saved machine opens straight to the form.
  const [manual, setManual] = useState(Boolean(editId))
  const [discovered, setDiscovered] = useState<SshIapTarget[] | null>(null)

  const [label, setLabel] = useState(editConfig?.label ?? '')
  const [url, setUrl] = useState(editConfig?.kind === 'ws' ? editConfig.url : '')
  const [token, setToken] = useState(editConfig?.token ?? '')
  const [project, setProject] = useState(editConfig?.kind === 'iap' ? editConfig.project : '')
  const [zone, setZone] = useState(editConfig?.kind === 'iap' ? editConfig.zone : '')
  const [instance, setInstance] = useState(editConfig?.kind === 'iap' ? editConfig.instance : '')
  const [port, setPort] = useState(
    editConfig?.kind === 'iap' ? String(editConfig.port) : DEFAULT_IAP_PORT,
  )

  const [permission, requestPermission] = useCameraPermissions()
  const scannedRef = useRef(false)

  const scanning = kind === 'ws' && !manual && !editId

  useEffect(() => {
    if (scanning && !permission?.granted) void requestPermission()
  }, [scanning, permission?.granted, requestPermission])

  useEffect(() => {
    if (kind !== 'iap') return
    let cancelled = false
    const configs = useConnectionsStore.getState().configs
    void Promise.all(
      configs.map(
        (c) =>
          getClient(c.id)
            ?.listIapTargets()
            .catch(() => [] as SshIapTarget[]) ?? Promise.resolve([] as SshIapTarget[]),
      ),
    ).then((lists) => {
      if (cancelled) return
      const seen = new Set<string>()
      const merged: SshIapTarget[] = []
      for (const target of lists.flat()) {
        const key = `${target.project}/${target.zone}/${target.instance}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(target)
      }
      setDiscovered(merged)
    })
    return () => {
      cancelled = true
    }
  }, [kind])

  const saveWs = (rawUrl: string, rawToken: string, rawLabel?: string) => {
    // The server prints a full `ws://host:port?token=...`, so pasting that whole
    // string into Address is the obvious move. Parse it FIRST and prefer the
    // token it carries; blindly appending the token field produced
    // `?token=abc?token=xyz`, which parses as the token "abc?token=xyz" and
    // fails auth for a reason nothing on screen explains.
    const fromUrl = parsePairingUrl(rawUrl.trim())
    const trimmedToken = rawToken.trim()
    const parsed =
      fromUrl?.token || !trimmedToken
        ? fromUrl
        : parsePairingUrl(`${fromUrl?.url ?? rawUrl.trim()}?token=${encodeURIComponent(trimmedToken)}`)
    if (!parsed) {
      Alert.alert('Not a machine address', 'Expected something like ws://192.168.1.8:8765')
      return
    }
    // Default the name to the host so the scan path needs no typing at all.
    const name = (rawLabel ?? '').trim() || parsed.url.replace(/^wss?:\/\//, '')
    const store = useConnectionsStore.getState()
    // `session: undefined` on an edit is deliberate: re-pairing with a fresh
    // code must not keep a session minted for the previous credential.
    const credentials = { token: parsed.token, pairing: parsed.pairing, session: undefined }
    if (editId) {
      store.updateConnection(editId, { label: name, url: parsed.url, ...credentials })
      store.disconnect(editId)
      store.connect(editId)
    } else {
      const id = `c-${Date.now()}`
      store.addConnection({ id, kind: 'ws', label: name, url: parsed.url, ...credentials })
      store.connect(id)
    }
    navigation.goBack()
  }

  const saveIap = (target?: SshIapTarget) => {
    const p = target?.project ?? project.trim()
    const z = target?.zone ?? zone.trim()
    const i = target?.instance ?? instance.trim()
    const name = (target?.alias ?? label).trim() || i
    const portNum = Number(port)
    if (!p || !z || !i) {
      Alert.alert('Missing details', 'Project, zone and instance are all required.')
      return
    }
    if (!Number.isInteger(portNum) || portNum <= 0) {
      Alert.alert('Bad port', `"${port}" is not a port. The server default is ${DEFAULT_IAP_PORT}.`)
      return
    }
    const patch = {
      label: name,
      project: p,
      zone: z,
      instance: i,
      port: portNum,
      token: token.trim() || undefined,
    }
    const store = useConnectionsStore.getState()
    if (editId) {
      store.updateConnection(editId, patch)
      store.disconnect(editId)
      store.connect(editId)
    } else {
      const id = `c-${Date.now()}`
      store.addConnection({ id, kind: 'iap', ...patch })
      store.connect(id)
    }
    navigation.goBack()
  }

  const onScanned = ({ data }: { data: string }) => {
    if (scannedRef.current) return
    scannedRef.current = true
    const parsed = parsePairingUrl(data)
    if (!parsed) {
      // Unlatch: a stray QR in frame should not wedge the scanner.
      scannedRef.current = false
      log.warn('scanned a code that is not a machine address')
      return
    }
    // Hand saveWs the RAW payload, not the parsed pieces: it re-parses, and
    // passing url+token discarded the pairing code the QR now carries.
    saveWs(data.trim(), '')
  }

  if (scanning) {
    return (
      <View style={styles.scanScreen}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
        ) : (
          <View style={styles.permissionWrap}>
            <Text style={styles.permissionText}>Camera access is needed to scan a pairing QR.</Text>
            <Pressable
              onPress={() => void requestPermission()}
              style={({ pressed }) => [styles.ghostWide, pressed && styles.pressed]}
            >
              <Text style={styles.ghostText}>Allow camera</Text>
            </Pressable>
          </View>
        )}

        <View style={styles.reticle} pointerEvents="none" />

        <View style={styles.scanFoot}>
          <Text style={styles.scanHint}>
            Point at the QR your machine printed on startup, or the one in desktop Settings, Mobile.
          </Text>
          <View style={styles.scanActions}>
            <Pressable
              onPress={() => setManual(true)}
              style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}
            >
              <Text style={styles.ghostText}>Type it instead</Text>
            </Pressable>
            <Pressable
              onPress={() => setKind('iap')}
              style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}
            >
              <Text style={styles.ghostText}>Add a work VM</Text>
            </Pressable>
          </View>
        </View>
      </View>
    )
  }

  if (kind === 'iap') {
    return (
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
          <Text style={styles.overline}>WORK VM OVER IAP</Text>

          {discovered === null ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator size="small" color={colors.textDim} />
              <Text style={styles.mutedBody}>Asking your machines what they can reach</Text>
            </View>
          ) : discovered.length > 0 ? (
            <>
              <Text style={styles.mutedBody}>From your Mac&apos;s ssh config. Tap to add.</Text>
              {discovered.map((target) => (
                <Pressable
                  key={`${target.project}/${target.zone}/${target.instance}`}
                  onPress={() => saveIap(target)}
                  style={({ pressed }) => [styles.targetRow, pressed && styles.rowPressed]}
                >
                  <Text style={styles.targetAlias} numberOfLines={1}>
                    {target.alias}
                  </Text>
                  <Text style={styles.targetMeta} numberOfLines={1}>
                    {target.project} · {target.zone}
                  </Text>
                </Pressable>
              ))}
            </>
          ) : (
            <View style={styles.notice}>
              <Text style={styles.noticeTitle}>Nothing to discover yet</Text>
              <Text style={styles.mutedBody}>
                VMs come from your Mac&apos;s ssh config, and only the desktop app can read it. Pair
                with a machine started by
              </Text>
              <Text style={styles.codeInline}>npm run dev</Text>
              <Text style={styles.mutedBody}>and they appear here automatically.</Text>
            </View>
          )}

          {!manual ? (
            <Pressable
              onPress={() => setManual(true)}
              style={({ pressed }) => [styles.ghostWide, pressed && styles.pressed]}
            >
              <Text style={styles.ghostText}>Enter one manually</Text>
            </Pressable>
          ) : (
            <View style={styles.manualBlock}>
              <Field label="Name" value={label} onChange={setLabel} placeholder="optional" />
              <Field label="Project" value={project} onChange={setProject} placeholder="prj-..." mono />
              <Field label="Zone" value={zone} onChange={setZone} placeholder="asia-south1-b" mono />
              <Field label="Instance" value={instance} onChange={setInstance} placeholder="vm-name" mono />
              <Field label="Port" value={port} onChange={setPort} placeholder={DEFAULT_IAP_PORT} mono numeric />
              <Field label="Token" value={token} onChange={setToken} placeholder="from the server" mono />
              <Pressable
                onPress={() => saveIap()}
                style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
              >
                <Text style={styles.ctaText}>{editId ? 'Save' : 'Add VM'}</Text>
              </Pressable>
            </View>
          )}

          {!editId && (
            <Pressable
              onPress={() => {
                setKind('ws')
                setManual(false)
              }}
              style={({ pressed }) => [styles.ghostWide, pressed && styles.pressed]}
            >
              <Text style={styles.ghostText}>Scan a QR instead</Text>
            </Pressable>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    )
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Text style={styles.overline}>{editId ? 'EDIT MACHINE' : 'MACHINE ADDRESS'}</Text>
        <Field label="Name" value={label} onChange={setLabel} placeholder="optional" />
        <Field label="Address" value={url} onChange={setUrl} placeholder="ws://192.168.1.8:8765" mono />
        <Field label="Token" value={token} onChange={setToken} placeholder="from the server" mono />
        <Pressable
          onPress={() => saveWs(url, token, label)}
          style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
        >
          <Text style={styles.ctaText}>{editId ? 'Save' : 'Connect'}</Text>
        </Pressable>
        {!editId && (
          <Pressable
            onPress={() => setManual(false)}
            style={({ pressed }) => [styles.ghostWide, pressed && styles.pressed]}
          >
            <Text style={styles.ghostText}>Scan a QR instead</Text>
          </Pressable>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  form: { padding: space.lg, paddingBottom: space.xxl },
  overline: {
    ...type.label,
    color: colors.textFaint,
    textTransform: 'uppercase',
    marginBottom: space.md,
  },
  mutedBody: { ...type.bodySm, color: colors.textDim, marginBottom: space.sm },

  scanScreen: { flex: 1, backgroundColor: '#000' },
  reticle: {
    position: 'absolute',
    top: '20%',
    left: '12%',
    right: '12%',
    aspectRatio: 1,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: radius.lg,
  },
  scanFoot: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
    paddingBottom: space.xl,
    backgroundColor: 'rgba(0,0,0,0.72)',
    gap: space.md,
  },
  scanHint: { ...type.bodySm, color: colors.text, textAlign: 'center' },
  scanActions: { flexDirection: 'row', gap: space.sm },
  permissionWrap: { flex: 1, justifyContent: 'center', padding: space.xl, gap: space.md },
  permissionText: { ...type.body, color: colors.text, textAlign: 'center' },

  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginBottom: space.md },

  targetRow: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    marginBottom: space.sm,
    minHeight: HIT + 8,
    justifyContent: 'center',
  },
  rowPressed: { backgroundColor: colors.surfaceRaised },
  targetAlias: { ...type.heading, color: colors.text },
  targetMeta: { ...type.monoSm, color: colors.textFaint, marginTop: 2 },

  notice: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: space.md,
    marginBottom: space.md,
  },
  noticeTitle: { ...type.heading, color: colors.text, marginBottom: space.xs },
  codeInline: { ...type.mono, color: colors.accent, marginBottom: space.sm },

  manualBlock: { marginTop: space.md },
  field: { marginBottom: space.md },
  fieldLabel: {
    ...type.label,
    color: colors.textFaint,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  input: {
    ...type.body,
    color: colors.text,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: HIT + 4,
  },
  inputMono: { ...type.mono, paddingVertical: space.md },

  cta: {
    marginTop: space.sm,
    minHeight: HIT + 4,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaText: { fontFamily: fonts.display, fontSize: 15, color: '#08131f' },
  ghost: {
    flex: 1,
    minHeight: HIT,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  ghostWide: {
    marginTop: space.md,
    minHeight: HIT,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostText: { ...type.bodySm, color: colors.text },
  pressed: { opacity: 0.55 },
})
