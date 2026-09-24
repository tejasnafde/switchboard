export type GoogleMintActionTone = 'primary' | 'secondary'

export function googleClientUpdate(
  clientId: string,
  clientSecret: string,
): { clientId: string; clientSecret?: string } {
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
  }
}

export function googleMintActionClass(tone: GoogleMintActionTone): string {
  return `google-mint-action google-mint-action--${tone}`
}
