/**
 * Key a desktop stores an html-live still image under: lowercase hex SHA-256
 * of the UTF-8 bytes of the block source (`isHtmlLiveImageKey` in
 * @shared/html-live checks the shape).
 */
import * as Crypto from 'expo-crypto'

export function htmlLiveImageKey(source: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, source, {
    encoding: Crypto.CryptoEncoding.HEX,
  })
}
