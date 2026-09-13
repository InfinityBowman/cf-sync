// Deterministic ids for MutatorContext.nextId (ARCHITECTURE.md#optimistic-intents).
// Both runs of a mutation share its seed, so a pure-JS generator is the only
// option: Web Crypto is async and apply is synchronous.

/** cyrb128: a string to four 32-bit words of PRNG state. */
function hashSeed(seed: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/**
 * A generator of UUID-shaped ids that is a pure function of `seed`: the same
 * seed yields the same sequence, call by call, on every runtime. Ids carry
 * the v4 version and variant bits so they are indistinguishable from
 * `crypto.randomUUID()` output, but they are not random — two generators
 * over one seed agree, which is what lets a mutator mint ids in both runs.
 */
export function createIdSource(seed: string): () => string {
  let [a, b, c, d] = hashSeed(seed)
  // sfc32
  const next = (): number => {
    a |= 0
    b |= 0
    c |= 0
    d |= 0
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return t >>> 0
  }
  return () => {
    const bytes = new Uint8Array(16)
    for (let i = 0; i < 16; i += 4) {
      const word = next()
      bytes[i] = word >>> 24
      bytes[i + 1] = (word >>> 16) & 0xff
      bytes[i + 2] = (word >>> 8) & 0xff
      bytes[i + 3] = word & 0xff
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x40
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    let out = ''
    for (let i = 0; i < 16; i++) {
      if (i === 4 || i === 6 || i === 8 || i === 10) out += '-'
      out += HEX[bytes[i]!]
    }
    return out
  }
}

/** The seed a client mints per mutation at `mutate()` time. */
export function mintSeed(): string {
  return crypto.randomUUID()
}
