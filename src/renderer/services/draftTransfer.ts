import type { DraftPill, ImageAttachment } from '../stores/draft-store'

export interface DraftPayload {
  text: string
  pills: readonly DraftPill[]
  images: readonly ImageAttachment[]
}

export interface DraftCloneOptions {
  nextId: () => string
  createPreviewUrl: (file: File) => string
}

export interface DraftTransferEndpoint {
  machineId?: string
  instanceId?: string
}

export function requiresDraftTransferConfirmation(
  source: DraftTransferEndpoint,
  target: DraftTransferEndpoint,
): boolean {
  const sourceMachine = source.machineId ?? 'local'
  const targetMachine = target.machineId ?? 'local'
  return sourceMachine !== targetMachine || source.instanceId !== target.instanceId
}

export function withDraftProvenance(text: string, sourceLabel: string): string {
  return `> Prompt copied from ${sourceLabel}\n\n${text}`
}

export function cloneDraftPayload(
  source: DraftPayload,
  options: DraftCloneOptions,
): { text: string; pills: DraftPill[]; images: ImageAttachment[] } {
  let text = source.text
  const pills = source.pills.map((pill) => {
    const id = options.nextId()
    text = text.split(`[[pill:${pill.id}]]`).join(`[[pill:${id}]]`)
    return { ...pill, id }
  })
  const images = source.images.map((image) => ({
    id: options.nextId(),
    file: image.file,
    previewUrl: options.createPreviewUrl(image.file),
  }))
  return { text, pills, images }
}
