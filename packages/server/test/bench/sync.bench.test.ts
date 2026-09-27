/**
 * Timings for a workspace the size of a large real project (~60k rows,
 * ~13 MB of row JSON). Opt-in, never part of `pnpm test`:
 *
 *   CF_SYNC_BENCH=1 pnpm vitest run --project bench
 *
 * The socket here only counts bytes and watches for pokeEnd, so the numbers
 * are the DO's cost plus transport, not a client's parse.
 */
import { PROTOCOL_VERSION } from '@cf-sync/protocol/internal'
import { SELF } from 'cloudflare:test'
import { it } from 'vitest'

// The runner's process.env is not visible inside workerd; edit here to scale.
const ROWS = 60_000
const CHECKLISTS = 840
const AUTH = { 'x-test-admin': 'yes' }

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

async function seed(workspace: string): Promise<void> {
  const rows: Array<{ tbl: string; id: string; data: Record<string, unknown> }> = []
  for (let c = 0; c < CHECKLISTS; c++) {
    rows.push({ tbl: 'counters', id: uuid(c), data: { studyId: uuid(c >> 2), type: 'ROB2', status: 'finalized' } })
  }
  for (let i = 0; i < ROWS; i++) {
    const checklistId = uuid(i % CHECKLISTS)
    const key = `domain${i % 7}.q${i % 13}`
    rows.push({
      tbl: 'todos',
      id: `${checklistId}:${key}:${i}`,
      data: { id: `${checklistId}:${key}:${i}`, studyId: uuid((i % CHECKLISTS) >> 2), checklistId, key, value: i % 3 ? 'Y' : 'PN' },
    })
  }
  const res = await SELF.fetch(`https://test/admin/${workspace}/import`, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify({ formatVersion: 1, schemaVersion: 1, rows }),
  })
  if (!res.ok) throw new Error(`import failed: ${res.status} ${await res.text()}`)
}

class RawClient {
  bytes = 0
  frames = 0
  #ws!: WebSocket
  #onEnd: (() => void) | null = null
  #onError: ((err: Error) => void) | null = null

  static async open(workspace: string, clientId: string): Promise<RawClient> {
    const client = new RawClient()
    const res = await SELF.fetch(`https://test/sync/${workspace}?clientId=${clientId}`, { headers: { Upgrade: 'websocket' } })
    const ws = res.webSocket
    if (!ws) throw new Error(`upgrade failed: ${res.status}`)
    ws.accept()
    ws.addEventListener('message', (event: MessageEvent) => {
      const text = String(event.data)
      client.bytes += text.length
      client.frames++
      if (text.startsWith('{"type":"error"')) {
        client.#onError?.(new Error(text))
        return
      }
      if (text.startsWith('{"type":"pokeEnd"')) {
        const done = client.#onEnd
        client.#onEnd = null
        done?.()
      }
    })
    client.#ws = ws
    return client
  }

  /** Sends msg and resolves at the next pokeEnd. */
  roundTrip(msg: unknown, timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no pokeEnd within ${timeoutMs} ms`)), timeoutMs)
      this.#onEnd = () => {
        clearTimeout(timer)
        resolve()
      }
      this.#onError = (err) => {
        clearTimeout(timer)
        reject(err)
      }
      this.#ws.send(JSON.stringify(msg))
    })
  }

  hello(): Promise<void> {
    return this.roundTrip({ type: 'hello', protocolVersion: PROTOCOL_VERSION, schemaVersion: 1, cursor: null })
  }

  close(): void {
    this.#ws.close(1000, 'bench done')
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

async function timed(fn: () => Promise<void>, label?: string): Promise<number> {
  const t0 = Date.now()
  await fn()
  const ms = Date.now() - t0
  if (label) console.log(`[cf-sync bench] ${label}: ${ms} ms`)
  return ms
}

it('sync engine timings', async () => {
  const workspace = `bench-${Date.now()}`
  const seedMs = await timed(() => seed(workspace), 'import')
  const results: Record<string, string> = { [`import ${ROWS + CHECKLISTS} rows`]: `${seedMs} ms` }

  // Wake the DO and warm the isolate before timing anything.
  const warm = await RawClient.open(workspace, 'warm')
  await timed(() => warm.hello(), 'first hello (wakes the DO)')
  const snapshotKB = Math.round(warm.bytes / 1024)
  results['snapshot size'] = `${snapshotKB} KB in ${warm.frames} frames`

  const single: number[] = []
  for (let i = 0; i < 3; i++) {
    const client = await RawClient.open(workspace, `cold-${i}`)
    single.push(await timed(() => client.hello()))
    client.close()
  }
  results['cold hello, 1 client (median of 3)'] = `${median(single)} ms`

  const concurrent: number[] = []
  for (let round = 0; round < 2; round++) {
    const clients = await Promise.all([0, 1, 2, 3, 4].map((i) => RawClient.open(workspace, `burst-${round}-${i}`)))
    concurrent.push(await timed(() => Promise.all(clients.map((c) => c.hello())).then(() => {})))
    for (const c of clients) c.close()
  }
  results['cold hello, 5 concurrent, all done (median of 2)'] = `${median(concurrent)} ms`

  const pusher = warm
  let mutationId = 0
  const push = (name: string, args: unknown) =>
    pusher.roundTrip({ type: 'push', mutations: [{ id: ++mutationId, name, args, seed: crypto.randomUUID() }] })

  const put: number[] = []
  for (let i = 0; i < 5; i++) {
    put.push(await timed(() => push('sync.put', { tbl: 'todos', id: `new-${i}`, data: { title: 'x', i } })))
  }
  results['push sync.put, 1 row (median of 5)'] = `${median(put)} ms`

  const bulk: number[] = []
  for (let i = 0; i < 5; i++) bulk.push(await timed(() => push('ids.mint', { count: 500 })))
  results['push one mutation writing 500 rows (median of 5)'] = `${median(bulk)} ms`

  const filtered: number[] = []
  for (let i = 0; i < 5; i++) {
    filtered.push(await timed(() => push('where.echo', { into: `echo-${i}`, where: { checklistId: uuid(i) } })))
  }
  results['push filtered tx.list over todos (median of 5)'] = `${median(filtered)} ms`

  const scan: number[] = []
  for (let i = 0; i < 3; i++) scan.push(await timed(() => push('todos.clearCompleted', null)))
  results['push full tx.list scan of todos (median of 3)'] = `${median(scan)} ms`

  // A write moves the data version, so each of these hellos builds the snapshot anew.
  const uncached: number[] = []
  for (let i = 0; i < 3; i++) {
    await push('sync.put', { tbl: 'todos', id: `bump-${i}`, data: { i } })
    const client = await RawClient.open(workspace, `rebuild-${i}`)
    uncached.push(await timed(() => client.hello()))
    client.close()
  }
  results['cold hello after a write, snapshot rebuilt (median of 3)'] = `${median(uncached)} ms`

  pusher.close()
  console.log(`\n[cf-sync bench] ${ROWS} rows\n${Object.entries(results).map(([k, v]) => `  ${k.padEnd(58)} ${v}`).join('\n')}\n`)
})
