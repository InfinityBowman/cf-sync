const encoder = new TextEncoder()

export function jsonByteSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length
}

export class OversizeItemError extends Error {
  constructor(
    readonly itemBytes: number,
    readonly maxBytes: number,
  ) {
    super(`single item of ${itemBytes} bytes exceeds the ${maxBytes}-byte frame budget`)
    this.name = 'OversizeItemError'
  }
}

/**
 * Greedily packs items into chunks bounded by both encoded byte size and item
 * count. A single item larger than maxBytes throws — callers must enforce row
 * size limits upstream (MAX_ROW_BYTES) so this never fires in production.
 */
export function chunkBySize<T>(
  items: readonly T[],
  opts: { maxBytes: number; maxItems?: number; sizeOf: (item: T) => number },
): T[][] {
  const maxItems = opts.maxItems ?? Number.POSITIVE_INFINITY
  const chunks: T[][] = []
  let current: T[] = []
  let currentBytes = 0

  for (const item of items) {
    const bytes = opts.sizeOf(item)
    if (bytes > opts.maxBytes) throw new OversizeItemError(bytes, opts.maxBytes)
    if (current.length > 0 && (currentBytes + bytes > opts.maxBytes || current.length >= maxItems)) {
      chunks.push(current)
      current = []
      currentBytes = 0
    }
    current.push(item)
    currentBytes += bytes
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
