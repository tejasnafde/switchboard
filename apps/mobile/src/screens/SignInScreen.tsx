/**
 * Google account screen. The token this obtains is what lets an IAP connection
 * dial a work VM, so signing in here is the difference between the app working
 * from a phone and needing the laptop open.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { createLogger } from '@shared/logger'
import { colors } from '../theme'
import { getSignedInEmail, importCredentials, parseCredentialBlob, signOut } from '../lib/google-auth'

const log = createLogger('screen:sign-in')

export default function SignInScreen() {
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
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
      setError('That does not look like the blob the mint script printed.')
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
        setError('Camera access is needed to scan the QR from your terminal.')
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
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>Google account</Text>
      <Text style={styles.body}>
        Switchboard reaches work VMs through Google Cloud IAP, a relay that needs no VPN and no
        inbound port. IAP will only forward a connection for a signed-in Google identity, so this
        app asks Google directly for an access token with cloud-platform scope. With one, a phone can
        drive a VM backend with the laptop closed.
      </Text>
      <Text style={styles.bodyDim}>
        The token is stored in the device keychain, never in app storage, and is refreshed silently.
        Sign-out revokes it at Google.
      </Text>

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
          <Text style={styles.code}>node scripts/google-mint-token.mjs</Text>
          <Text style={styles.stepBody}>Run that on your Mac, then scan the QR it prints.</Text>

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
              <Text style={styles.primaryButtonText}>Scan QR from terminal</Text>
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
  )
}

const styles = StyleSheet.create({
  scanBox: {
    marginBottom: 12,
  },
  camera: {
    height: 260,
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 10,
  },
  orText: {
    color: colors.textFaint,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 14,
    marginBottom: 8,
  },
  stepTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 6,
  },
  stepBody: {
    color: colors.textDim,
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 8,
  },
  code: {
    color: colors.accent,
    fontSize: 13,
    fontFamily: 'monospace',
    backgroundColor: colors.surfaceRaised,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 10,
  },
  blobInput: {
    color: colors.text,
    fontSize: 12,
    fontFamily: 'monospace',
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 10,
    minHeight: 92,
    textAlignVertical: 'top',
    marginBottom: 12,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  content: {
    padding: 20,
    gap: 14,
  },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  body: {
    color: colors.textDim,
    fontSize: 14,
    lineHeight: 21,
  },
  bodyDim: {
    color: colors.textFaint,
    fontSize: 13,
    lineHeight: 20,
  },
  accountCard: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    padding: 14,
    marginTop: 4,
  },
  accountLabel: {
    color: colors.textFaint,
    fontSize: 12,
    marginBottom: 4,
  },
  accountEmail: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  error: {
    color: colors.red,
    fontSize: 13,
    lineHeight: 19,
  },
  busyRow: {
    alignItems: 'center',
    paddingVertical: 14,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 13,
    marginTop: 4,
  },
  primaryButtonText: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  secondaryButton: {
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 13,
    marginTop: 4,
  },
  secondaryButtonText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.6,
  },
  redirect: {
    color: colors.textFaint,
    fontSize: 12,
    marginTop: 18,
  },
  redirectHint: {
    color: colors.textFaint,
    fontSize: 11,
    lineHeight: 17,
  },
})
