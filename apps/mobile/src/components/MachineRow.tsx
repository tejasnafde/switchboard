/**
 * One machine on the Machines screen: dot, name, the short certificate
 * fingerprint where one is pinned, then the transport and the address. A row
 * this app will not dial carries an amber hint with the two ways out; a row
 * whose certificate changed carries the red re-pair hint. Rules and copy live
 * in @shared/connection-security, shared with native Android.
 */
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import {
  CONNECTION_SECURITY_COPY as COPY,
  securityLabel,
  shortFingerprint,
  showsFingerprint,
  showsLock,
  fingerprintInUrl,
  type ConnectionSecurity,
} from '@shared/connection-security'
import { colors, fonts, radius, space, statusColor, type, HIT } from '../theme'
import type { ConnectionConfig, ConnectionStatus } from '../stores/connections'

/** The address after the transport label: host and port, or the IAP zone. */
function rowAddress(config: ConnectionConfig): string {
  return config.kind === 'iap' ? config.zone : config.url.replace(/^wss?:\/\//, '').replace(/\?.*$/, '')
}

const ON_ACCENT = '#08131f'
const AMBER_WASH = 'rgba(210,153,34,0.08)'
const AMBER_EDGE = 'rgba(210,153,34,0.35)'
const RED_WASH = 'rgba(248,81,73,0.08)'
const RED_EDGE = 'rgba(248,81,73,0.35)'

export function MachineRow({
  config,
  status,
  detail,
  security,
  onOpen,
  onActions,
  onScan,
  onUseIap,
  onRemove,
}: {
  config: ConnectionConfig
  status: ConnectionStatus
  detail?: string
  security: ConnectionSecurity
  onOpen: () => void
  onActions: () => void
  onScan: () => void
  onUseIap: () => void
  onRemove: () => void
}) {
  const tint =
    security === 'refused'
      ? colors.amber
      : security === 'certificate-changed'
        ? colors.red
        : (statusColor[status] ?? colors.textFaint)
  const fingerprint = config.kind === 'ws' && showsFingerprint(security) ? fingerprintInUrl(config.url) : null
  const short = shortFingerprint(fingerprint)
  const warns = security === 'refused' || security === 'certificate-changed'
  // The transport line replaces the status word; a dial problem still says why.
  const why = status !== 'connected' && !warns && detail ? detail : null
  return (
    <View style={styles.card}>
      <Pressable
        onPress={onOpen}
        onLongPress={onActions}
        accessibilityRole="button"
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        {status === 'connecting' && !warns ? (
          <ActivityIndicator size="small" color={tint} style={styles.spinner} />
        ) : (
          <View testID={`machine-dot-${security}`} style={[styles.dot, { backgroundColor: tint }]} />
        )}
        <View style={styles.body}>
          <View style={styles.top}>
            <Text style={styles.name} numberOfLines={1}>
              {config.label}
            </Text>
            {short ? (
              <Text style={styles.fingerprint} testID="machine-fingerprint">
                {short}
              </Text>
            ) : null}
          </View>
          <View style={styles.detail}>
            {showsLock(security) ? <Ionicons name="lock-closed" size={11} color={colors.textDim} /> : null}
            {warns ? <Ionicons name="warning" size={11} color={colors.textDim} /> : null}
            <Text style={styles.detailText}>{securityLabel(security)}</Text>
            <Text style={styles.sep}>·</Text>
            <Text style={styles.address} numberOfLines={1}>
              {rowAddress(config)}
            </Text>
          </View>
          {why ? <Text style={styles.why}>{why}</Text> : null}
        </View>
      </Pressable>
      {security === 'refused' ? (
        <View style={[styles.hint, { backgroundColor: AMBER_WASH, borderColor: AMBER_EDGE }]}>
          <Text style={styles.hintText}>{COPY.refusedHint}</Text>
          <View style={styles.hintActions}>
            <HintButton label={COPY.scanNewQr} primary onPress={onScan} />
            <HintButton label={COPY.useCloudIap} onPress={onUseIap} />
          </View>
        </View>
      ) : null}
      {security === 'certificate-changed' ? (
        <View style={[styles.hint, { backgroundColor: RED_WASH, borderColor: RED_EDGE }]}>
          <Text style={styles.hintText}>
            {COPY.certificateExpectedInline} {COPY.certificateUnexpectedTitle}{' '}
            <CertificateUnexpected fingerprint={short} />
          </Text>
          <View style={styles.hintActions}>
            <HintButton label={COPY.scanQrAgain} primary onPress={onScan} />
            <HintButton label={COPY.remove} onPress={onRemove} />
          </View>
        </View>
      ) : null}
    </View>
  )
}

/** The interception sentence with the pinned short fingerprint set in mono. */
function CertificateUnexpected({ fingerprint }: { fingerprint: string | null }) {
  const [before, after] = COPY.certificateUnexpectedBody.split('{fingerprint}')
  return (
    <>
      {before}
      <Text style={styles.hintMono}>{fingerprint ?? '?'}</Text>
      {after}
    </>
  )
}

function HintButton({ label, primary, onPress }: { label: string; primary?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={(HIT - 40) / 2}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.buttonPrimary : styles.buttonSecondary,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.buttonText, primary && { color: ON_ACCENT }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginBottom: space.sm,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: HIT },
  pressed: { opacity: 0.55 },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
  spinner: { width: 7, transform: [{ scale: 0.6 }] },
  body: { flex: 1, minWidth: 0, gap: 3 },
  top: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  name: { ...type.heading, color: colors.text, flexShrink: 1 },
  fingerprint: { ...type.mono, color: colors.textDim },
  detail: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detailText: { fontSize: 13, lineHeight: 18, color: colors.textDim },
  sep: { fontSize: 13, lineHeight: 18, color: colors.textFaint },
  address: { ...type.mono, color: colors.textDim, flexShrink: 1 },
  why: { ...type.monoSm, color: colors.textDim },
  hint: {
    marginTop: space.sm,
    marginBottom: space.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
  },
  hintText: { fontSize: 13, lineHeight: 18, color: colors.text },
  hintMono: { fontFamily: fonts.mono, fontSize: 12 },
  hintActions: { flexDirection: 'row', gap: space.sm, marginTop: 10 },
  button: { minHeight: 40, borderRadius: radius.md, paddingHorizontal: 14, justifyContent: 'center' },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  buttonText: { fontFamily: fonts.display, fontSize: 15, color: colors.text },
})
