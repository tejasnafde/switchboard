/**
 * How a client shrinks an attached image to fit the 3 MiB message limit
 * (`validateUserMessageImages`). Pure: each client supplies its own encoder
 * (desktop canvas, expo-image-manipulator, Android Bitmap), and the Android
 * port in `ImageResizePlan.kt` keeps the same numbers.
 */

/** Ceiling on the encoded data URLs of one message; the backend enforces the same. */
export const MESSAGE_IMAGE_WIRE_BUDGET = 3 * 1024 * 1024

/** A PNG (a screenshot) stays PNG only while it is this small, else it becomes a JPEG. */
export const PNG_KEEP_WIRE_BYTES = 1024 * 1024

export type ResizeFormat = 'jpeg' | 'png'

export interface ResizeAttempt {
  maxSide: number
  /** 0-1; ignored for PNG. */
  quality: number
  format: ResizeFormat
}

/** Tried in order until one fits: full size first, then smaller and softer. */
export const JPEG_STEPS: readonly ResizeAttempt[] = [
  { maxSide: 2048, quality: 0.85, format: 'jpeg' },
  { maxSide: 1600, quality: 0.85, format: 'jpeg' },
  { maxSide: 1280, quality: 0.75, format: 'jpeg' },
]

/**
 * The encodings to try for a source type, or null for a GIF: re-encoding
 * would drop its animation, so a GIF is sent as is or refused.
 */
export function resizeAttempts(sourceMimeType: string): readonly ResizeAttempt[] | null {
  if (sourceMimeType === 'image/gif') return null
  if (sourceMimeType === 'image/png') return [{ maxSide: 2048, quality: 1, format: 'png' }, ...JPEG_STEPS]
  return JPEG_STEPS
}

/** Scale to at most `maxSide` on the long side, keeping the aspect ratio. Never upscales. */
export function fitWithin(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) return { width, height, scaled: false }
  const longest = Math.max(width, height)
  if (longest <= maxSide) return { width, height, scaled: false }
  const ratio = maxSide / longest
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  }
}

export function mimeTypeOf(format: ResizeFormat): string {
  return format === 'png' ? 'image/png' : 'image/jpeg'
}

/** Length of `data:<mime>;base64,<data>` for `byteLength` raw bytes. */
export function dataUrlWireBytes(mimeType: string, byteLength: number): number {
  return `data:${mimeType};base64,`.length + 4 * Math.ceil(byteLength / 3)
}

/** Whether an encoded attempt is good enough to keep. */
export function attemptFits(attempt: ResizeAttempt, wireBytes: number, remaining: number): boolean {
  const ceiling = attempt.format === 'png' ? Math.min(PNG_KEEP_WIRE_BYTES, remaining) : remaining
  return wireBytes <= ceiling
}

export type ResizeOutcome<T> =
  | { ok: true; result: T; attempt: ResizeAttempt }
  | { ok: false; reason: 'too-large' | 'over-message-budget' }

/**
 * Try each attempt until one fits the `remaining` budget of this message.
 * `too-large` means the image does not fit even alone; `over-message-budget`
 * means it would have fit an empty message but not what is left of this one.
 */
export async function shrinkToBudget<T>(
  attempts: readonly ResizeAttempt[],
  remaining: number,
  encode: (attempt: ResizeAttempt) => Promise<{ result: T; wireBytes: number }>,
): Promise<ResizeOutcome<T>> {
  let smallest = Infinity
  for (const attempt of attempts) {
    const { result, wireBytes } = await encode(attempt)
    if (attemptFits(attempt, wireBytes, remaining)) return { ok: true, result, attempt }
    if (attempt.format === 'jpeg') smallest = Math.min(smallest, wireBytes)
  }
  return { ok: false, reason: smallest <= MESSAGE_IMAGE_WIRE_BUDGET ? 'over-message-budget' : 'too-large' }
}

/** A GIF (or any image sent unchanged) either fits what is left, or is refused with the reason. */
export function sendAsIs(wireBytes: number, remaining: number): 'ok' | 'over-message-budget' | 'gif-too-large' {
  if (wireBytes <= remaining) return 'ok'
  return wireBytes <= MESSAGE_IMAGE_WIRE_BUDGET ? 'over-message-budget' : 'gif-too-large'
}

export type ImageRefusal = 'too-large' | 'over-message-budget' | 'gif-too-large' | 'unreadable' | 'unsupported-type'

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`
}

/** One line naming the image and why it was not attached. */
export function imageRefusalMessage(name: string, reason: ImageRefusal): string {
  const budget = mib(MESSAGE_IMAGE_WIRE_BUDGET)
  switch (reason) {
    case 'too-large':
      return `${name} is still over ${budget} after shrinking it to ${JPEG_STEPS[JPEG_STEPS.length - 1].maxSide} px`
    case 'over-message-budget':
      return `${name} did not fit: the images in one message can total at most ${budget}`
    case 'gif-too-large':
      return `${name} is a GIF over ${budget}; GIFs are sent unchanged to keep their animation`
    case 'unsupported-type':
      return `${name} must be PNG, JPEG, WebP, or GIF`
    case 'unreadable':
      return `${name} could not be read`
  }
}
