/** Composer image attachments: pick button and thumbnail strip. Rules in lib/images.ts. */
import React, { memo, useCallback } from 'react'
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import { createLogger } from '@shared/logger'
import { assetToPayload, fitTurnBudget, formatBytes, MAX_IMAGE_BYTES, MAX_TURN_WIRE_BYTES, type ImagePayload } from '../lib/images'
import { colors, radius, space, type } from '../theme'

const log = createLogger('composer:images')

/** A picked image plus the local uri, kept only so the thumbnail can render. */
export interface Attachment extends ImagePayload {
  id: string
  previewUri: string
}

/** Cap per turn. Each image is a full base64 payload over the socket. */
const MAX_PER_TURN = 4

export const AttachButton = memo(function AttachButton({
  count,
  existing,
  onAdd,
}: {
  count: number
  /** Already-attached images, needed to measure the remaining turn budget. */
  existing: Attachment[]
  onAdd: (added: Attachment[]) => void
}) {
  const pick = useCallback(async () => {
    if (count >= MAX_PER_TURN) {
      Alert.alert('Attachment limit', `Up to ${MAX_PER_TURN} images per message.`)
      return
    }
    try {
      // The OS picker needs no permission grant on either platform.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        // The bytes must travel: a file:// uri means nothing to a remote backend.
        base64: true,
        allowsMultipleSelection: true,
        selectionLimit: MAX_PER_TURN - count,
        // Camera-roll originals are far larger than a model needs.
        quality: 0.7,
      })
      if (result.canceled) return

      const added: Attachment[] = []
      const rejected: string[] = []
      for (const [i, asset] of result.assets.entries()) {
        const converted = assetToPayload(asset)
        if (!converted.ok) {
          rejected.push(
            converted.reason === 'too-large'
              ? `${asset.fileName ?? 'image'} is over ${formatBytes(MAX_IMAGE_BYTES)}`
              : `${asset.fileName ?? 'image'} could not be read`,
          )
          continue
        }
        added.push({
          ...converted.payload,
          id: `img-${i}-${asset.assetId ?? asset.uri}`,
          previewUri: asset.uri,
        })
      }

      // Total matters too: an oversized turn drops the connection outright.
      const { accepted, rejected: overBudget } = fitTurnBudget(existing, added)
      if (overBudget.length > 0) {
        rejected.push(
          `${overBudget.length} ${overBudget.length === 1 ? 'image was' : 'images were'} skipped - over the ` +
            `${formatBytes(MAX_TURN_WIRE_BYTES)} total for one message`,
        )
      }

      if (rejected.length > 0) {
        // Silently attaching 2 of 3 is worse than an alert.
        log.warn('rejected attachments', rejected)
        Alert.alert('Some images were not attached', rejected.join('\n'))
      }
      if (accepted.length > 0) onAdd(accepted)
    } catch (err) {
      log.warn('image pick failed', err)
      Alert.alert('Could not open your photos', err instanceof Error ? err.message : String(err))
    }
  }, [count, existing, onAdd])

  return (
    <Pressable
      onPress={() => void pick()}
      style={({ pressed }) => [styles.attachButton, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel="Attach an image"
      hitSlop={8}
    >
      <Ionicons name="add" size={22} color={colors.textDim} />
    </Pressable>
  )
})

export const AttachmentStrip = memo(function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: Attachment[]
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
      {attachments.map((a) => (
        <View key={a.id} style={styles.thumbWrap}>
          <Image source={{ uri: a.previewUri }} style={styles.thumb} />
          <Pressable
            onPress={() => onRemove(a.id)}
            style={styles.removeButton}
            accessibilityRole="button"
            accessibilityLabel="Remove this image"
            hitSlop={8}
          >
            <Text style={styles.removeGlyph}>×</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  )
})

const styles = StyleSheet.create({
  attachButton: {
    width: 40,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  pressed: { opacity: 0.6 },
  strip: { flexGrow: 0, marginBottom: space.sm },
  thumbWrap: { marginRight: space.sm },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: radius.sm,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.surfaceRaised,
  },
  removeButton: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeGlyph: { color: colors.text, ...type.monoSm, lineHeight: 14 },
})
