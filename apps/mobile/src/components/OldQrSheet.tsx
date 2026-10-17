/**
 * Shown instead of saving when a scanned or typed address is plain ws:// to
 * another computer and this build will not dial it: the QR came from a
 * Switchboard that predates the certificate pin. Offers the same two ways out
 * as the refused machine row.
 */
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { CONNECTION_SECURITY_COPY as COPY } from '@shared/connection-security'
import { colors, fonts, radius, space, type, HIT } from '../theme'

export function OldQrSheet({
  address,
  onScanAgain,
  onUseIap,
  onCancel,
}: {
  /** The refused address; the sheet is hidden while null. */
  address: string | null
  onScanAgain: () => void
  onUseIap: () => void
  onCancel: () => void
}) {
  return (
    <Modal visible={address !== null} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.grab} />
          {/* Scrolls when large text makes it taller than the screen. */}
          <ScrollView bounces={false}>
            <View style={styles.head}>
              <Ionicons name="warning" size={20} color={colors.amber} />
              <Text style={styles.title} accessibilityRole="header">
                {COPY.oldQrTitle}
              </Text>
            </View>
            <Text style={styles.body}>{COPY.oldQrBody}</Text>
            <View style={styles.address}>
              <Text style={styles.addressText} numberOfLines={1}>
                {address}
              </Text>
              <Text style={[styles.addressText, { color: colors.amber }]}>{COPY.noCertificate}</Text>
            </View>
            <Option title={COPY.oldQrScanAgain} body={COPY.oldQrScanAgainBody} primary onPress={onScanAgain} />
            <Option title={COPY.oldQrCloudIap} body={COPY.oldQrCloudIapBody} onPress={onUseIap} />
            <Pressable
              onPress={onCancel}
              accessibilityRole="button"
              style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}
            >
              <Text style={styles.cancelText}>{COPY.cancel}</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}

function Option({
  title,
  body,
  primary,
  onPress,
}: {
  title: string
  body: string
  primary?: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => [styles.option, primary && styles.optionPrimary, pressed && styles.pressed]}
    >
      <Text style={[styles.optionTitle, primary && { color: colors.accent }]}>{title}</Text>
      <Text style={styles.optionBody}>{body}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 34,
    maxHeight: '90%',
  },
  grab: {
    width: 36,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.borderStrong,
    alignSelf: 'center',
    marginBottom: 18,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: space.sm },
  title: { fontFamily: fonts.display, fontSize: 20, lineHeight: 25, color: colors.text, flexShrink: 1 },
  body: { fontSize: 15, lineHeight: 22, color: colors.textDim, marginBottom: 14 },
  address: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space.sm,
    backgroundColor: colors.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: space.sm,
    paddingHorizontal: 11,
    paddingVertical: 9,
    marginBottom: space.lg,
  },
  addressText: { ...type.mono, color: colors.textDim, flexShrink: 1 },
  option: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceRaised,
    borderRadius: space.md,
    paddingHorizontal: 14,
    paddingVertical: space.md,
    marginBottom: 10,
    minHeight: HIT,
  },
  optionPrimary: { borderColor: colors.accent, backgroundColor: colors.accentWash },
  optionTitle: { fontFamily: fonts.display, fontSize: 15, lineHeight: 20, color: colors.text },
  optionBody: { fontSize: 13, lineHeight: 18, color: colors.textDim, marginTop: 2 },
  cancel: { alignItems: 'center', justifyContent: 'center', minHeight: HIT, marginTop: space.xs },
  cancelText: { fontFamily: fonts.display, fontSize: 15, color: colors.textDim },
  pressed: { opacity: 0.55 },
})
