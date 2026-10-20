import { htmlLiveImageKey } from '../html-live-key'

jest.mock('expo-crypto', () => {
  const { createHash } = jest.requireActual('crypto')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    digestStringAsync: jest.fn(async (_algorithm: string, data: string) =>
      createHash('sha256').update(data, 'utf8').digest('hex'),
    ),
  }
})

it('keys a still image by the SHA-256 of the source UTF-8', async () => {
  await expect(htmlLiveImageKey('<script src="/_sb/chart.js"></script>\n<canvas id="c"></canvas>')).resolves.toBe(
    '9235215ba9292f8dd21fecf0305a4b7d067e4cb41901b6840e8a6f5f2551a065',
  )
  await expect(htmlLiveImageKey('é<b>')).resolves.toBe(
    '039cda1cb184022e2fbb117ce36a746e5abafe0846b588428ef5b69d87410e9a',
  )
})
