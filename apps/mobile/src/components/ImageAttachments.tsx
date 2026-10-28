/**
 * Composer attachments: the attach button (Photos or Files) and the image
 * thumbnail strip. Image rules in lib/images.ts, file rules in lib/file-attachments.ts.
 */
import React, { memo, useCallback, useRef, useState } from 'react'
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as ImagePicker from 'expo-image-picker'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import * as FileSystem from 'expo-file-system/legacy'
import * as DocumentPicker from 'expo-document-picker'
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
import { refusalLine, routePickedFile } from '../lib/file-attachments'
import { AttachSheet, type AttachSource } from './FileAttachments'
import { colors, radius, space, type } from '../theme'

const log = createLogger('composer:images')

/** A picked image plus the local uri, kept only so the thumbnail can render. */
export interface Attachment extends ImagePayload {
  id: string
  previewUri: string
}

type Shrunk = { ok: true; payload: ImagePayload } | { ok: false; reason: ImageRefusal }

/** A picked image from either picker. The document picker reports no size in pixels. */
interface ImageSource {
  uri: string
  width?: number
  height?: number
  fileSize?: number | null
}

function pixelSize(uri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => Image.getSize(uri, (width, height) => resolve({ width, height }), reject))
}

/**
 * Scale and re-encode one picked image to fit `remaining` bytes. The decoder
 * applies EXIF orientation, and the re-encoded file carries no EXIF.
 */
async function shrinkAsset(asset: ImageSource, sourceType: string, remaining: number): Promise<Shrunk> {
  const attempts = resizeAttempts(sourceType)
  if (!attempts) {
    // A GIF goes as is: re-encoding would drop its animation.
    if (asset.fileSize && sendAsIs(dataUrlWireBytes(sourceType, asset.fileSize), remaining) === 'gif-too-large') {
      return { ok: false, reason: 'gif-too-large' }
    }
    const size = asset.width && asset.height ? { width: asset.width, height: asset.height } : await pixelSize(asset.uri)
    if (sendAsIs(0, remaining, Math.max(size.width, size.height)) === 'gif-too-wide')
      return { ok: false, reason: 'gif-too-wide' }
    const b64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.Base64 })
    const url = `data:${sourceType};base64,${b64}`
    const fit = sendAsIs(url.length, remaining, Math.max(size.width, size.height))
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

interface PickedImage extends ImageSource {
  key: string
  name: string
  sourceType: string | null
}

/** Each image is shrunk to fit what is left of the message's budget. */
async function shrinkAll(
  existing: Attachment[],
  images: PickedImage[],
): Promise<{ added: Attachment[]; rejected: string[] }> {
  let remaining = MAX_TURN_WIRE_BYTES - totalWireBytes(existing)
  const added: Attachment[] = []
  const rejected: string[] = []
  for (const image of images) {
    let shrunk: Shrunk
    try {
      shrunk = image.sourceType
        ? await shrinkAsset(image, image.sourceType, remaining)
        : { ok: false, reason: 'unsupported-type' }
    } catch (err) {
      log.warn('image resize failed', { name: image.name, err })
      shrunk = { ok: false, reason: 'unreadable' }
    }
    if (!shrunk.ok) {
      rejected.push(imageRefusalMessage(image.name, shrunk.reason))
      continue
    }
    remaining -= shrunk.payload.url.length
    added.push({ ...shrunk.payload, id: image.key, previewUri: image.uri })
  }
  return { added, rejected }
}

export const AttachButton = memo(function AttachButton({
  existing,
  onAdd,
  onFiles,
  onRefused,
  canUploadFiles,
}: {
  /** Already-attached images, needed to measure the remaining turn budget. */
  existing: Attachment[]
  onAdd: (added: Attachment[]) => void
  /** Picked files that are not images, to upload. */
  onFiles: (files: Array<{ name: string; uri: string }>) => void
  /** One line per file that was not attached; an empty list clears the last ones. */
  onRefused: (lines: string[]) => void
  /** The backend's `attachment_upload_v1`, read at pick time. */
  canUploadFiles: () => boolean
}) {
  const [sheetOpen, setSheetOpen] = useState(false)
  const chosen = useRef<AttachSource | null>(null)

  const pickPhotos = useCallback(async () => {
    try {
      // The OS picker needs no permission grant on either platform.
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 0,
      })
      if (result.canceled) return
      const { added, rejected } = await shrinkAll(
        existing,
        result.assets.map((asset, i) => ({
          key: `img-${i}-${asset.assetId ?? asset.uri}`,
          name: asset.fileName ?? `Image ${i + 1}`,
          uri: asset.uri,
          width: asset.width,
          height: asset.height,
          fileSize: asset.fileSize,
          sourceType: resizeSourceType(asset),
        })),
      )
      // Silently attaching 2 of 3 is worse than a note.
      if (rejected.length > 0) log.warn('rejected attachments', rejected)
      onRefused(rejected)
      if (added.length > 0) onAdd(added)
    } catch (err) {
      log.warn('image pick failed', err)
      Alert.alert('Could not open your photos', err instanceof Error ? err.message : String(err))
    }
  }, [existing, onAdd, onRefused])

  const pickFiles = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true })
      if (result.canceled) return
      const canUpload = canUploadFiles()
      const images: PickedImage[] = []
      const files: Array<{ name: string; uri: string }> = []
      const refused: string[] = []
      for (const [i, asset] of result.assets.entries()) {
        const route = routePickedFile(asset, canUpload)
        if (route.kind === 'image')
          images.push({
            key: `doc-${i}-${asset.uri}`,
            name: asset.name,
            uri: asset.uri,
            fileSize: asset.size,
            sourceType: route.sourceType,
          })
        else if (route.kind === 'file') files.push({ name: asset.name, uri: asset.uri })
        else refused.push(refusalLine(asset.name, route.reason))
      }
      const { added, rejected } = await shrinkAll(existing, images)
      const lines = [...refused, ...rejected]
      if (lines.length > 0) log.warn('rejected attachments', lines)
      onRefused(lines)
      if (added.length > 0) onAdd(added)
      if (files.length > 0) onFiles(files)
    } catch (err) {
      log.warn('file pick failed', err)
      Alert.alert('Could not open your files', err instanceof Error ? err.message : String(err))
    }
  }, [existing, onAdd, onFiles, onRefused, canUploadFiles])

  const opened = useCallback(() => {
    const source = chosen.current
    chosen.current = null
    if (source === 'photos') void pickPhotos()
    else if (source === 'files') void pickFiles()
  }, [pickPhotos, pickFiles])

  return (
    <>
      <Pressable
        onPress={() => setSheetOpen(true)}
        style={({ pressed }) => [styles.attachButton, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="Attach photos or files"
        hitSlop={8}
      >
        <Ionicons name="add" size={22} color={colors.textDim} />
      </Pressable>
      <AttachSheet
        visible={sheetOpen}
        onPick={(source) => {
          chosen.current = source
          setSheetOpen(false)
        }}
        onClose={() => setSheetOpen(false)}
        onDismiss={opened}
      />
    </>
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
    width: 48,
    height: 48,
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
