/** Composer image attachments: pick button and thumbnail strip. Rules in lib/images.ts. */
import React, { memo, useCallback } from 'react'
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as FileSystem from 'expo-file-system/legacy'
import { createLogger } from '@shared/logger'
import {
  dataUrlWireBytes,
  fitWithin,
  imageRefusalMessage,
  mimeTypeOf,
  resizeAttempts,
  sendAsIs,
  shrinkToBudget,
  type ImageRefusal,
} from '@shared/image-resize'
import { MAX_TURN_WIRE_BYTES, resizeSourceType, totalWireBytes, type ImagePayload } from '../lib/images'
import { colors, radius, space, type } from '../theme'

const log = createLogger('composer:images')

/** A picked image plus the local uri, kept only so the thumbnail can render. */
export interface Attachment extends ImagePayload {
  id: string
  previewUri: string
}

type Shrunk = { ok: true; payload: ImagePayload } | { ok: false; reason: ImageRefusal }

/**
 * Scale and re-encode one picked image to fit `remaining` bytes. The decoder
 * applies EXIF orientation, and the re-encoded file carries no EXIF.
 */
async function shrinkAsset(asset: ImagePicker.ImagePickerAsset, sourceType: string, remaining: number): Promise<Shrunk> {
  const attempts = resizeAttempts(sourceType)
  if (!attempts) {
    // A GIF goes as is: re-encoding would drop its animation.
    if (asset.fileSize && sendAsIs(dataUrlWireBytes(sourceType, asset.fileSize), remaining) === 'gif-too-large') {
      return { ok: false, reason: 'gif-too-large' }
    }
    const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 })
    const url = `data:${sourceType};base64,${b64}`
    const fit = sendAsIs(url.length, remaining)
    return fit === 'ok' ? { ok: true, payload: { url, mimeType: sourceType } } : { ok: false, reason: fit }
  }
  const source = await ImageManipulator.manipulate(asset.uri).renderAsync()
  try {
    const outcome = await shrinkToBudget(attempts, remaining, async (attempt) => {
      const size = fitWithin(source.width, source.height, attempt.maxSide)
      const image = size.scaled
        ? await ImageManipulator.manipulate(source).resize({ width: size.width, height: size.height }).renderAsync()
        : source
      try {
        const saved = await image.saveAsync({
          base64: true,
          compress: attempt.quality,
          format: attempt.format === 'png' ? SaveFormat.PNG : SaveFormat.JPEG,
        })
        const url = `data:${mimeTypeOf(attempt.format)};base64,${saved.base64 ?? ''}`
        return { result: url, wireBytes: url.length }
      } finally {
        if (image !== source) image.release()
      }
    })
    if (!outcome.ok) return outcome
    return { ok: true, payload: { url: outcome.result, mimeType: mimeTypeOf(outcome.attempt.format) } }
  } finally {
    source.release()
  }
}

export const AttachButton = memo(function AttachButton({
  existing,
  onAdd,
}: {
  /** Already-attached images, needed to measure the remaining turn budget. */
  existing: Attachment[]
  onAdd: (added: Attachment[]) => void
}) {
  const pick = useCallback(async () => {
    try {
      // The OS picker needs no permission grant on either platform.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 0,
      })
      if (result.canceled) return

      // Each image is shrunk to fit what is left of the message's budget.
      let remaining = MAX_TURN_WIRE_BYTES - totalWireBytes(existing)
      const added: Attachment[] = []
      const rejected: string[] = []
      for (const [i, asset] of result.assets.entries()) {
        const name = asset.fileName ?? `Image ${i + 1}`
        const sourceType = resizeSourceType(asset)
        let shrunk: Shrunk
        try {
          shrunk = sourceType ? await shrinkAsset(asset, sourceType, remaining) : { ok: false, reason: 'unsupported-type' }
        } catch (err) {
          log.warn('image resize failed', { name, err })
          shrunk = { ok: false, reason: 'unreadable' }
        }
        if (!shrunk.ok) {
          rejected.push(imageRefusalMessage(name, shrunk.reason))
          continue
        }
        remaining -= shrunk.payload.url.length
        added.push({
          ...shrunk.payload,
          id: `img-${i}-${asset.assetId ?? asset.uri}`,
          previewUri: asset.uri,
        })
      }

      if (rejected.length > 0) {
        // Silently attaching 2 of 3 is worse than an alert.
        log.warn('rejected attachments', rejected)
        Alert.alert('Some images were not attached', rejected.join('\n'))
      }
      if (added.length > 0) onAdd(added)
    } catch (err) {
      log.warn('image pick failed', err)
      Alert.alert('Could not open your photos', err instanceof Error ? err.message : String(err))
    }
  }, [existing, onAdd])

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
