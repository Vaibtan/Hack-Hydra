/** Largest text stored on one vertex; the rest spills into chunk vertices (CONTEXT.md: 32 743-byte property cap). */
export const CHUNK_BYTES = 30_000

/** Splits at code-point boundaries so no chunk exceeds CHUNK_BYTES of UTF-8. */
export const chunkText = (text: string): ReadonlyArray<string> => {
  if (Buffer.byteLength(text, "utf8") <= CHUNK_BYTES) return [text]
  const chunks: Array<string> = []
  let current = ""
  let bytes = 0
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint, "utf8")
    if (bytes + size > CHUNK_BYTES) {
      chunks.push(current)
      current = ""
      bytes = 0
    }
    current += codePoint
    bytes += size
  }
  chunks.push(current)
  return chunks
}
