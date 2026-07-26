/**
 * Google account screen. The token this obtains is what lets an IAP connection
 * dial a work VM, so signing in here is the difference between the app working
 * from a phone and needing the laptop open.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { createLogger } from '@shared/logger'
import { colors } from '../theme'
import { getRedirectUri, getSignedInEmail, signIn, signOut } from '../lib/google-auth'

const log = createLogger('screen:sign-in')

export default function SignInScreen() {
  const [email, setEmail] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')

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

  const handleSignIn = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await signIn()
      if (result === null) {
        // Either cancelled or the id_token carried no email claim; re-read the
        // stored session rather than guessing which.
        await load()
        return
      }
      setEmail(result)
    } catch (err) {
      log.error('google sign-in failed', err)
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.')
    } finally {
      setBusy(false)
    }
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
        <Pressable
          onPress={handleSignIn}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <Text style={styles.primaryButtonText}>Sign in with Google</Text>
        </Pressable>
      )}

      <Text style={styles.redirect} numberOfLines={2}>
        Redirect URI: {getRedirectUri()}
      </Text>
      <Text style={styles.redirectHint}>
        This exact value must be registered on the OAuth client, or Google answers
        redirect_uri_mismatch.
      </Text>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
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
