/**
 * Bottom-anchored update banners, one per update lane.
 *
 * `<UpdateBanner />` is mounted once in App.tsx over the navigator, so it
 * overlays every screen and survives navigation. It renders nothing at all when
 * there is no update, which is the normal case.
 *
 * Two lanes, both surfaced here (see src/lib/selfUpdate.ts and src/lib/otaUpdate.ts):
 * - APK: a newer native binary on GitHub Releases. Download plus an install prompt.
 * - OTA: a newer JS bundle, already downloaded. Just needs a restart.
 *
 * When both are pending the APK banner comes first, since the native binary is
 * the one that gates what the JS bundle is allowed to use.
 */
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { createLogger } from '@shared/logger'
import { colors } from '../theme'
import { checkForApkUpdate, downloadAndInstall, type ApkUpdate } from '../lib/selfUpdate'
import { useOtaUpdate } from '../lib/otaUpdate'

const log = createLogger('mobile:update-banner')

export function UpdateBanner() {
  return (
    <View style={styles.host} pointerEvents="box-none">
      <ApkUpdateBanner />
      <OtaUpdateBanner />
    </View>
  )
}

/** Newer APK on GitHub Releases: download it, then hand off to the installer. */
function ApkUpdateBanner() {
  const [update, setUpdate] = useState<ApkUpdate | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    // Never rejects, but a stray rejection must not go unlogged.
    checkForApkUpdate()
      .then((found) => {
        if (mounted) setUpdate(found)
      })
      .catch((err) => log.warn('apk update check rejected unexpectedly', err))
    return () => {
      mounted = false
    }
  }, [])

  const install = useCallback(() => {
    if (!update) return
    setBusy(true)
    setError(null)
    downloadAndInstall(update)
      .catch((err) => {
        log.warn('apk install handoff failed', err)
        setError(err instanceof Error ? err.message : 'Install failed')
      })
      .finally(() => setBusy(false))
  }, [update])

  if (!update) return null

  return (
    <Banner
      title={`Switchboard ${update.version} is ready`}
      subtitle={busy ? 'Downloading' : 'Update installs from a GitHub release'}
      actionLabel="Install"
      busy={busy}
      error={error}
      onPress={install}
    />
  )
}

/** New JS bundle already downloaded: all that is left is a restart. */
function OtaUpdateBanner() {
  const { ready, applying, error, apply } = useOtaUpdate()

  if (!ready) return null

  return (
    <Banner
      title="An update is ready"
      subtitle={applying ? 'Restarting' : 'Restart to apply'}
      actionLabel="Restart"
      busy={applying}
      error={error}
      onPress={apply}
    />
  )
}

type BannerProps = {
  title: string
  subtitle: string
  actionLabel: string
  busy: boolean
  error: string | null
  onPress: () => void
}

function Banner({ title, subtitle, actionLabel, busy, error, onPress }: BannerProps) {
  return (
    <View style={styles.banner}>
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.subtitle, error ? styles.subtitleError : null]} numberOfLines={2}>
          {error ?? subtitle}
        </Text>
      </View>
      <Pressable
        onPress={onPress}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        style={({ pressed }) => [styles.action, pressed && styles.actionPressed, busy && styles.actionBusy]}
      >
        {busy ? (
          <ActivityIndicator size="small" color={colors.bg} />
        ) : (
          <Text style={styles.actionText}>{actionLabel}</Text>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 12,
    right: 12,
    // Clear of the Android gesture bar without pulling in a safe-area provider,
    // which the navigator owns and this overlay sits outside of.
    bottom: 28,
    gap: 8,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    // Keeps the banner legible over a scrolling message list.
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  subtitle: {
    color: colors.textDim,
    fontSize: 12,
  },
  subtitleError: {
    color: colors.red,
  },
  action: {
    minWidth: 78,
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: colors.accent,
  },
  actionPressed: {
    opacity: 0.75,
  },
  actionBusy: {
    opacity: 0.6,
  },
  actionText: {
    color: colors.bg,
    fontSize: 13,
    fontWeight: '700',
  },
})
