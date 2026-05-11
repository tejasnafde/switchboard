/**
 * Streaming JSON-RPC frame parser for LSP-over-stdio. LSP frames are:
 *
 *   Content-Length: <bytes>\r\n
 *   [optional headers]\r\n
 *   \r\n
 *   <body json>
 *
 * The parser holds incoming bytes in a Buffer, repeatedly:
 *   1. Look for `\r\n\r\n` to find the end of headers
 *   2. Read Content-Length, wait until that many body bytes are buffered
 *   3. Parse the body, yield the message, advance past it
 *
 * Bytes (not chars) are critical: UTF-8 multibyte characters mean a
 * frame's "length in chars" differs from "length in bytes". We always
 * count bytes via Buffer.length / Buffer.byteLength.
 */
export class LspFramer {
  private buf: Buffer = Buffer.alloc(0)

  /** Feed a chunk of stdout; returns any complete messages decoded from it. */
  feed(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: unknown[] = []
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n')
      if (headerEnd === -1) break
      const headers = this.buf.subarray(0, headerEnd).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(headers)
      if (!m) {
        // Malformed — drop everything up through the header terminator
        // and try to recover on subsequent chunks.
        this.buf = this.buf.subarray(headerEnd + 4)
        continue
      }
      const bodyLen = parseInt(m[1], 10)
      const bodyStart = headerEnd + 4
      if (this.buf.length < bodyStart + bodyLen) break
      const body = this.buf.subarray(bodyStart, bodyStart + bodyLen).toString('utf8')
      try {
        out.push(JSON.parse(body))
      } catch {
        // Drop malformed JSON silently; remaining buffer still drains.
      }
      this.buf = this.buf.subarray(bodyStart + bodyLen)
    }
    return out
  }
}
