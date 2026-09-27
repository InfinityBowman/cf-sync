/**
 * Client-side cost of a large workspace (~60k rows). Opt-in, never part of
 * `pnpm test`:
 *
 *   CF_SYNC_BENCH=1 pnpm vitest run test/bench
 *
 * Frames are built the way the server chunks them, then fed through a fake
 * socket into a SyncClient with real TanStack DB collections.
 */
import { MAX_PART_PATCH_BYTES, chunkBySize, jsonByteSize, serverMsgSchema } from '@cf-sync/protocol/internal'
import { it } from 'vitest'
import { SyncClient } from '../../src/client'
import { createCollections } from '../../src/collection'
import { MemorySyncStore } from '../../src/store'
import { FakeSocket, flushMicrotasks } from '../fake-socket'
import { testApp } from '../test-schema'

const ROWS = 60_000
const CHECKLISTS = 840

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

type Op = { op: 'clear' } | { op: 'put'; tbl: string; id: string; value: Record<string, unknown> }

function snapshotOps(): Op[] {
  const ops: Op[] = [{ op: 'clear' }]
  for (let c = 0; c < CHECKLISTS; c++) {
    ops.push({ op: 'put', tbl: 'notes', id: uuid(c), value: { id: uuid(c), studyId: uuid(c >> 2), type: 'ROB2' } })
  }
  for (let i = 0; i < ROWS; i++) {
    const checklistId = uuid(i % CHECKLISTS)
    const key = `domain${i % 7}.q${i % 13}`
    const id = `${checklistId}:${key}:${i}`
    ops.push({
      op: 'put',
      tbl: 'todos',
      id,
      value: { id, studyId: uuid((i % CHECKLISTS) >> 2), checklistId, key, value: i % 3 ? 'Y' : 'PN' },
    })
  }
  // The server sends a snapshot ORDER BY tbl, id.
  const [clear, ...puts] = ops
  puts.sort((a, b) => {
    const x = a as Extract<Op, { op: 'put' }>
    const y = b as Extract<Op, { op: 'put' }>
    return x.tbl < y.tbl ? -1 : x.tbl > y.tbl ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0
  })
  return [clear!, ...puts]
}

function snapshotFrames(clientId: string): string[] {
  const ops = snapshotOps()
  const pokeId = 'bench-poke'
  const frames = [JSON.stringify({ type: 'pokeStart', pokeId, baseCursor: null })]
  const chunks = chunkBySize(ops, { maxBytes: MAX_PART_PATCH_BYTES, sizeOf: jsonByteSize })
  let sent = 0
  chunks.forEach((patch, i) => {
    sent += patch.length
    const part: Record<string, unknown> = { type: 'pokePart', pokeId, patch, remaining: ops.length - sent }
    if (i === 0) part.lastMutationIdChanges = { [clientId]: 0 }
    frames.push(JSON.stringify(part))
  })
  frames.push(
    JSON.stringify({ type: 'pokeEnd', pokeId, cursor: { backendId: 'b1', version: 1 }, pageInfo: { more: false } }),
  )
  return frames
}

function time(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return Math.round(performance.now() - t0)
}

async function timeAsync(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now()
  await fn()
  return Math.round(performance.now() - t0)
}

function makeClient(store?: MemorySyncStore) {
  let socket: FakeSocket | null = null
  const client = new SyncClient({
    url: 'ws://bench',
    workspaceId: 'bench',
    clientId: 'bench-client',
    autoStart: false,
    app: testApp,
    ...(store ? { store } : {}),
    createSocket: () => (socket = new FakeSocket()),
  })
  const collections = createCollections(client, { startSync: true })
  return { client, collections, socket: () => socket! }
}

it('client bootstrap timings', async () => {
  const frames = snapshotFrames('bench-client')
  const bytes = frames.reduce((n, f) => n + f.length, 0)
  const results: Record<string, string> = { 'snapshot size': `${Math.round(bytes / 1024)} KB in ${frames.length} frames` }

  // Warm the JIT on the parse path before timing it.
  for (const frame of frames.slice(0, 3)) serverMsgSchema.safeParse(JSON.parse(frame))

  results['JSON.parse all frames'] = `${time(() => frames.forEach((f) => JSON.parse(f)))} ms`
  results['JSON.parse + serverMsgSchema.safeParse'] = `${time(() => frames.forEach((f) => serverMsgSchema.safeParse(JSON.parse(f))))} ms`

  const runs: number[] = []
  for (let r = 0; r < 3; r++) {
    const store = new MemorySyncStore()
    const { client, collections, socket } = makeClient(store)
    client.start()
    await flushMicrotasks(20)
    socket().open()
    runs.push(
      await timeAsync(async () => {
        for (const frame of frames) socket().receiveRaw(frame)
        await flushMicrotasks(20)
      }),
    )
    if (collections.todos.size !== ROWS) throw new Error(`expected ${ROWS} todos, got ${collections.todos.size}`)
    if (r === 2) {
      const hydrate = await timeAsync(async () => {
        const next = makeClient(store)
        next.client.start()
        await next.client.whenHydrated
        if (next.collections.todos.size !== ROWS) throw new Error(`hydrated ${next.collections.todos.size} todos`)
        await next.client.destroy()
      })
      results['hydrate 60k rows from a store into collections'] = `${hydrate} ms`
    }
    await client.destroy()
  }
  runs.sort((a, b) => a - b)
  results['receive + apply bootstrap poke (median of 3)'] = `${runs[1]} ms`

  console.log(`\n[cf-sync client bench] ${ROWS} rows\n${Object.entries(results).map(([k, v]) => `  ${k.padEnd(48)} ${v}`).join('\n')}\n`)
})
