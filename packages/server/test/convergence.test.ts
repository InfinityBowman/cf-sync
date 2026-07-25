import { describe, expect, it } from 'vitest'
import { TestClient, mulberry32 } from './harness'

/**
 * Seeded multi-client simulation (ARCHITECTURE.md#testing): random interleaved intent
 * mutations, duplicate pushes, and mid-stream reconnects. Invariant: after
 * quiescence every client's materialized state deep-equals a fresh
 * bootstrap's, and per-client LMIDs never regress.
 */

interface SimClient {
  tc: TestClient
  nextId: number
  lastBatch: { id: number; name: string; args: unknown }[] | null
}

const TODO_IDS = ['t1', 't2', 't3', 't4', 't5']
const COUNTER_IDS = ['a', 'b']

function randomOp(rand: () => number): { name: string; args: unknown } {
  const roll = rand()
  if (roll < 0.4) {
    const id = TODO_IDS[Math.floor(rand() * TODO_IDS.length)]!
    return { name: 'sync.put', args: { tbl: 'todos', id, data: { title: `v${Math.floor(rand() * 1000)}` } } }
  }
  if (roll < 0.6) {
    const id = TODO_IDS[Math.floor(rand() * TODO_IDS.length)]!
    return { name: 'sync.del', args: { tbl: 'todos', id } }
  }
  if (roll < 0.9) {
    const id = COUNTER_IDS[Math.floor(rand() * COUNTER_IDS.length)]!
    return { name: 'counter.increment', args: { id, by: 1 + Math.floor(rand() * 5) } }
  }
  return { name: 'todos.clearCompleted', args: {} }
}

function canonical(rows: Map<string, Record<string, unknown>>): string {
  return JSON.stringify([...rows.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

describe('convergence simulation', () => {
  it('3 clients, 90 random ops, duplicates and reconnects converge (seed 1337)', async () => {
    const rand = mulberry32(1337)
    const workspace = `sim-${Date.now()}`
    const clients: SimClient[] = []
    for (const name of ['c1', 'c2', 'c3']) {
      const tc = await TestClient.connect(workspace, name)
      await tc.syncOnce()
      clients.push({ tc, nextId: 1, lastBatch: null })
    }

    const OPS_PER_CLIENT = 30
    for (let round = 0; round < OPS_PER_CLIENT; round++) {
      for (const client of clients) {
        const dice = rand()
        if (dice < 0.1 && client.lastBatch) {
          // Duplicate delivery: replay the previous batch verbatim.
          client.tc.push(client.lastBatch)
        } else if (dice < 0.2) {
          // Drop the connection mid-stream and resume by cursor.
          await client.tc.reconnect()
          await client.tc.syncOnce()
        }
        const op = randomOp(rand)
        const batch = [{ id: client.nextId++, name: op.name, args: op.args }]
        client.lastBatch = batch
        client.tc.push(batch)
      }
    }

    // Quiescence: every client sees its own last mutation confirmed.
    for (const client of clients) {
      await client.tc.pokeUntilLmid(client.nextId - 1, 10_000)
    }

    // A fresh bootstrap is the authoritative reference.
    const reference = await TestClient.connect(workspace, 'observer')
    await reference.syncOnce()

    // Every client, after draining by cursor, must match it exactly.
    for (const client of clients) {
      await client.tc.pokeUntilVersion(reference.cursor!.version, 10_000)
      expect(canonical(client.tc.rows)).toBe(canonical(reference.rows))
      expect(client.tc.lmid).toBe(client.nextId - 1)
      client.tc.close()
    }
    reference.close()
  }, 60_000)
})
