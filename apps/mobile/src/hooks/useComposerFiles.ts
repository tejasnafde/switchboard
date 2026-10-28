/**
 * The composer's file chips: picked files and large pastes uploaded with
 * `app:upload-attachment`, and the refusal lines shown above the input.
 * Rules in lib/file-attachments.ts.
 */
import { useCallback, useRef, useState } from 'react'
import * as FileSystem from 'expo-file-system/legacy'
import { createLogger } from '@shared/logger'
import { attachmentLabel, nextPastedTextName, type SentAttachment } from '@shared/attachments'
import { getClient } from '../stores/connections'
import {
  base64Bytes,
  fileTooLarge,
  largePaste,
  newFileId,
  refusalLine,
  utf8Base64,
  type ComposerFile,
} from '../lib/file-attachments'

const log = createLogger('composer:files')

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useComposerFiles(connectionId: string, onPasteFailed: (at: number, inserted: string) => void) {
  const [files, setFilesState] = useState<ComposerFile[]>([])
  const [refusals, setRefusals] = useState<string[]>([])
  // Read synchronously by a paste in the same tick as a pick.
  const filesRef = useRef<ComposerFile[]>([])
  const setFiles = useCallback((next: (prev: ComposerFile[]) => ComposerFile[]) => {
    filesRef.current = next(filesRef.current)
    setFilesState(filesRef.current)
  }, [])

  const canUpload = useCallback(() => getClient(connectionId)?.canUploadAttachments() === true, [connectionId])

  /** Upload one file; true once its chip holds the saved path. A chip removed meanwhile stays removed. */
  const upload = useCallback(
    async (id: string, name: string, readData: () => Promise<string>, label: (pages?: number) => string) => {
      setFiles((prev) => [...prev, { id, name, label: name }])
      try {
        const client = getClient(connectionId)
        if (!client) throw new Error('Backend not connected.')
        const data = await readData()
        const tooLarge = fileTooLarge(base64Bytes(data))
        if (tooLarge) throw new Error(tooLarge)
        const saved = await client.uploadAttachment({ name, data })
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, path: saved.path, label: label(saved.pages) } : f)))
        return true
      } catch (err) {
        log.warn('attachment upload failed', { name, err })
        setFiles((prev) => prev.filter((f) => f.id !== id))
        setRefusals((prev) => [...prev, refusalLine(name, errorText(err))])
        return false
      }
    },
    [connectionId, setFiles],
  )

  /** Files the router sent here (not images): each uploads as its own chip. */
  const addPicked = useCallback(
    (picked: Array<{ name: string; uri: string }>) => {
      for (const file of picked) {
        void upload(
          newFileId(),
          file.name,
          () => FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 }),
          (pages) => attachmentLabel(file.name, { pages }),
        )
      }
    },
    [upload],
  )

  /**
   * The text the input should hold after a change. A paste over
   * LARGE_PASTE_BYTES comes out of it and uploads as `pasted-text-N.txt`.
   */
  const foldPaste = useCallback(
    (prev: string, next: string): string => {
      const paste = largePaste(prev, next)
      if (!paste || !canUpload()) return next
      const name = nextPastedTextName(filesRef.current.map((f) => f.label))
      const lines = paste.inserted.split('\n').length
      void upload(
        newFileId(),
        name,
        async () => utf8Base64(paste.inserted),
        () => attachmentLabel(name, { lines }),
      ).then((ok) => {
        if (!ok) onPasteFailed(paste.at, paste.inserted)
      })
      return paste.kept
    },
    [canUpload, upload, onPasteFailed],
  )

  const remove = useCallback((id: string) => setFiles((prev) => prev.filter((f) => f.id !== id)), [setFiles])

  /** Sent attachments back in the composer: a failed write or a returned draft. */
  const restore = useCallback(
    (sent: SentAttachment[]) => {
      if (sent.length === 0) return
      setFiles((prev) => [...prev, ...sent.filter((s) => !prev.some((f) => f.id === s.id))])
    },
    [setFiles],
  )

  const clear = useCallback(() => {
    setFiles(() => [])
    setRefusals([])
  }, [setFiles])

  return {
    files,
    refusals,
    canUpload,
    addPicked,
    foldPaste,
    remove,
    restore,
    clear,
    setRefusals,
  }
}
