/**
 * Bottom-anchored update banner for the OTA lane.
 *
 * `<UpdateBanner />` is mounted once in App.tsx over the navigator, so it
 * overlays every screen and survives navigation. It renders nothing at all when
 * there is no update, which is the normal case.
 *
 * A newer JS bundle (src/lib/ota-update.ts) is already downloaded and just needs
 * a restart. Native updates come from the App Store, not from this banner.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, space, type } from '../theme'
import { useOtaUpdate } from '../lib/ota-update'

export function UpdateBanner() {
  return (
    <View style={styles.host} pointerEvents="box-none">
      <OtaUpdateBanner />
    </View>
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
    left: space.md,
    right: space.md,
    // Clear of the Android gesture bar without pulling in a safe-area provider,
    // which the navigator owns and this overlay sits outside of.
    bottom: 28,
    gap: space.sm,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
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
    ...type.heading,
    color: colors.text,
  },
  subtitle: {
    ...type.bodySm,
    color: colors.textDim,
  },
  subtitleError: {
    color: colors.red,
  },
  action: {
    minWidth: 78,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  actionPressed: {
    opacity: 0.75,
  },
  actionBusy: {
    opacity: 0.6,
  },
  actionText: {
    fontFamily: fonts.display,
    fontSize: 13,
    color: '#08131f',
  },
})
