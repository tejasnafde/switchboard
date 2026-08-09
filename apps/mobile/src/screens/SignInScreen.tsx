/**
 * Google account screen. The token this obtains is what lets an IAP connection
 * dial a work VM, so signing in here is the difference between the app working
 * from a phone and needing the laptop open.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useHeaderHeight } from '@react-navigation/elements'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { createLogger } from '@shared/logger'
import { colors, fonts, radius, space, type, HIT } from '../theme'
import { getSignedInEmail, importCredentials, parseCredentialBlob, signOut } from '../lib/google-auth'
import { keyboardAvoidance } from '../lib/keyboardAvoidance'

const log = createLogger('screen:sign-in')

export default function SignInScreen() {
  const headerHeight = useHeaderHeight()
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [showWhy, setShowWhy] = useState(false)
  const [error, setError] = useState('')
  const [blob, setBlob] = useState('')
  const [scanning, setScanning] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  // A QR fires repeatedly while it stays in frame; the first accepted scan wins.
  const scannedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      setEmail(await getSignedInEmail())
    } catch (err) {
      log.warn('reading the stored session failed', err)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const adopt = async (raw: string) => {
    const creds = parseCredentialBlob(raw)
    if (!creds) {
      setError('That does not look like the code the desktop app showed you.')
      // Unlatch so the same scan session can try again; otherwise a bad QR
      // wedges the scanner until the user cancels out of it.
      scannedRef.current = false
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await importCredentials(creds)
      setBlob('')
      setScanning(false)
      if (result === null) {
        // Credentials were accepted but no email claim came back; re-read state
        // rather than guessing.
        await load()
        return
      }
      setEmail(result)
    } catch (err) {
      log.error('credential import failed', err)
      setError(err instanceof Error ? err.message : 'Import failed. Please try again.')
      scannedRef.current = false
    } finally {
      setBusy(false)
    }
  }

  const handleImport = () => void adopt(blob)

  const handleScanned = ({ data }: { data: string }) => {
    if (scannedRef.current) return
    scannedRef.current = true
    void adopt(data)
  }

  const startScanning = async () => {
    setError('')
    if (!permission?.granted) {
      const next = await requestPermission()
      if (!next.granted) {
        setError('Camera access is needed to scan the QR from the desktop app.')
        return
      }
    }
    scannedRef.current = false
    setScanning(true)
  }

  const handleSignOut = async () => {
    setBusy(true)
    setError('')
    try {
      await signOut()
      setEmail(null)
    } catch (err) {
      log.error('sign-out failed', err)
      setError('Sign-out failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    // The paste field sits low on a modal screen.
    <KeyboardAvoidingView style={styles.screen} {...keyboardAvoidance(Platform.OS, headerHeight)}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Google account</Text>
        <Text style={styles.body}>Needed to reach work VMs with your laptop closed.</Text>
        {/* The full rationale is worth having, but not worth reading twice - RN has
            no tooltip, so it collapses behind a disclosure instead. */}
        <Pressable onPress={() => setShowWhy((v) => !v)} hitSlop={8}>
          <Text style={styles.whyToggle}>{showWhy ? 'Hide details' : 'Why this is needed'}</Text>
        </Pressable>
        {showWhy ? (
          <Text style={styles.bodyDim}>
            Work VMs are reached through Google Cloud IAP, a relay needing no VPN and no inbound port.
            IAP only forwards for a signed-in Google identity, so the app asks Google directly for an
            access token with cloud-platform scope. The token lives in the device keychain, never in app
            storage, and refreshes silently. Signing out revokes it at Google.
          </Text>
        ) : null}

        {email ? (
          <View style={styles.accountCard}>
            <Text style={styles.accountLabel}>Signed in as</Text>
            <Text style={styles.accountEmail} numberOfLines={1}>
              {email}
            </Text>
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {busy ? (
          <View style={styles.busyRow}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : email ? (
          <Pressable
            onPress={handleSignOut}
            style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          >
            <Text style={styles.secondaryButtonText}>Sign out</Text>
          </Pressable>
        ) : (
          <View>
            <Text style={styles.stepTitle}>Connect your Google account</Text>
            <Text style={styles.stepBody}>Needed only to reach work VMs over IAP.</Text>
            <Text style={styles.stepBody}>
              On the desktop app, open Settings, then Mobile, then select Connect Google account. Sign
              in when the browser opens. Scan the QR it shows you.
            </Text>

            {scanning ? (
              <View style={styles.scanBox}>
                <CameraView
                  style={styles.camera}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={handleScanned}
                />
                <Pressable
                  onPress={() => setScanning(false)}
                  style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
                >
                  <Text style={styles.secondaryButtonText}>Cancel scan</Text>
                </Pressable>
              </View>
            ) : (
              <Pressable
                onPress={startScanning}
                style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
              >
                <Text style={styles.primaryButtonText}>Scan QR from desktop</Text>
              </Pressable>
            )}

            <Text style={styles.orText}>or paste it</Text>
            <TextInput
              style={styles.blobInput}
              value={blob}
              onChangeText={setBlob}
              placeholder='{"clientId":"...","refreshToken":"1//..."}'
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <Pressable
              onPress={handleImport}
              disabled={!blob.trim()}
              style={({ pressed }) => [
                styles.primaryButton,
                !blob.trim() && styles.buttonDisabled,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.primaryButtonText}>Import credentials</Text>
            </Pressable>
            <Text style={styles.redirectHint}>Stored in the device keychain. Treat it like a password.</Text>
          </View>
        )}

      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scanBox: {
    marginBottom: space.md,
  },
  camera: {
    height: 260,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginBottom: space.sm,
  },
  orText: {
    ...type.bodySm,
    color: colors.textFaint,
    textAlign: 'center',
    marginTop: space.md,
    marginBottom: space.sm,
  },
  stepTitle: {
    ...type.heading,
    color: colors.text,
    marginBottom: space.xs,
  },
  stepBody: {
    ...type.bodySm,
    color: colors.textDim,
    marginBottom: space.sm,
  },
  blobInput: {
    ...type.mono,
    color: colors.text,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 92,
    textAlignVertical: 'top',
    marginBottom: space.md,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  content: {
    padding: space.lg,
    gap: space.md,
  },
  title: {
    ...type.title,
    color: colors.text,
  },
  body: {
    ...type.body,
    color: colors.textDim,
  },
  bodyDim: {
    ...type.bodySm,
    color: colors.textFaint,
  },
  whyToggle: {
    ...type.bodySm,
    color: colors.accent,
    marginTop: space.xs,
  },
  accountCard: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: space.md,
    marginTop: space.xs,
  },
  accountLabel: {
    ...type.label,
    color: colors.textFaint,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  accountEmail: {
    ...type.heading,
    color: colors.text,
  },
  error: {
    ...type.bodySm,
    color: colors.red,
  },
  busyRow: {
    alignItems: 'center',
    paddingVertical: space.md,
  },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    minHeight: HIT + 4,
    marginTop: space.xs,
  },
  primaryButtonText: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: '#08131f',
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    minHeight: HIT,
    marginTop: space.xs,
  },
  secondaryButtonText: {
    fontFamily: fonts.display,
    fontSize: 15,
    color: colors.accent,
  },
  pressed: {
    opacity: 0.55,
  },
  redirectHint: {
    ...type.bodySm,
    color: colors.textFaint,
  },
})
