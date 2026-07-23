import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { IndexedDBSyncStore } from '../src/idb-store'
import type { PokePersist } from '../src/store'

const SCHEMA = 1

function makeStore(clientId = 'client-a', factory = new IDBFactory()) {
  return {
    factory,
    store: new IndexedDBSyncStore({ workspaceId: 'w1', clientId, indexedDB: factory }),
  }
}

function pokeUpdate(overrides: Partial<PokePersist> = {}): PokePersist {
  return {
    ops: [],
    clear: false,
    cursor: { backendId: 'b1', version: 1 },
    schemaVersion: SCHEMA,
    confirmedLmid: 0,
    outbox: [],
    ...overrides,
  }
}

describe('IndexedDBSyncStore', () => {
  it('returns null when nothing has been stored', async () => {
    const { store } = makeStore()
    expect(await store.load()).toBeNull()
  })

  it('round-trips rows, cursor, lmid, and outbox through applyPoke', async () => {
    const { store } = makeStore()
    await store.applyPoke(
      pokeUpdate({
        clear: true,
        ops: [
          { op: 'put', tbl: 'todos', id: 't1', value: { title: 'a' } },
          { op: 'put', tbl: 'notes', id: 'n1', value: { body: 'b' } },
        ],
        cursor: { backendId: 'b1', version: 3 },
        confirmedLmid: 2,
        outbox: [{ id: 3, name: 'sync.put', args: { x: 1 } }],
      }),
    )

    const state = await store.load()
    expect(state?.schemaVersion).toBe(SCHEMA)
    expect(state?.cursor).toEqual({ backendId: 'b1', version: 3 })
    expect(state?.confirmedLmid).toBe(2)
    expect(state?.outbox).toEqual([{ id: 3, name: 'sync.put', args: { x: 1 } }])
    expect(state?.rows).toEqual(
      expect.arrayContaining([
        { tbl: 'todos', id: 't1', value: { title: 'a' } },
        { tbl: 'notes', id: 'n1', value: { body: 'b' } },
      ]),
    )

    // Delta poke: put + del.
    await store.applyPoke(
      pokeUpdate({
        ops: [
          { op: 'del', tbl: 'todos', id: 't1' },
          { op: 'put', tbl: 'todos', id: 't2', value: { title: 'c' } },
        ],
        cursor: { backendId: 'b1', version: 4 },
      }),
    )
    const after = await store.load()
    expect(after?.rows).toEqual(
      expect.arrayContaining([
        { tbl: 'notes', id: 'n1', value: { body: 'b' } },
        { tbl: 'todos', id: 't2', value: { title: 'c' } },
      ]),
    )
    expect(after?.rows).toHaveLength(2)
  })

  it('skips row writes for pokes already subsumed by a newer writer', async () => {
    const { store } = makeStore()
    // A "newer tab" stored version 10.
    await store.applyPoke(
      pokeUpdate({
        clear: true,
        ops: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'v10 state' } }],
        cursor: { backendId: 'b1', version: 10 },
      }),
    )
    // An older poke (this tab lagging) must not regress rows or cursor…
    await store.applyPoke(
      pokeUpdate({
        ops: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'v8 state' } }],
        cursor: { backendId: 'b1', version: 8 },
        confirmedLmid: 7,
      }),
    )
    const state = await store.load()
    expect(state?.cursor).toEqual({ backendId: 'b1', version: 10 })
    expect(state?.rows).toEqual([{ tbl: 'todos', id: 't1', value: { title: 'v10 state' } }])
    // …but the caller's own outbox bookkeeping still lands.
    expect(state?.confirmedLmid).toBe(7)
  })

  it('applies clear pokes regardless of the stored cursor (backend reset)', async () => {
    const { store } = makeStore()
    await store.applyPoke(pokeUpdate({ clear: true, cursor: { backendId: 'b1', version: 10 } }))
    await store.applyPoke(
      pokeUpdate({
        clear: true,
        ops: [{ op: 'put', tbl: 'todos', id: 'n1', value: { title: 'new' } }],
        cursor: { backendId: 'b2', version: 1 },
      }),
    )
    const state = await store.load()
    expect(state?.cursor).toEqual({ backendId: 'b2', version: 1 })
    expect(state?.rows).toEqual([{ tbl: 'todos', id: 'n1', value: { title: 'new' } }])
  })

  it('partitions outboxes by clientId over a shared row cache', async () => {
    const factory = new IDBFactory()
    const a = makeStore('client-a', factory).store
    const b = makeStore('client-b', factory).store

    await a.applyPoke(
      pokeUpdate({
        clear: true,
        ops: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'shared' } }],
        cursor: { backendId: 'b1', version: 2 },
        confirmedLmid: 4,
        outbox: [{ id: 5, name: 'sync.put', args: {} }],
      }),
    )
    await b.saveOutbox([{ id: 9, name: 'sync.del', args: {} }], 8)

    const stateA = await a.load()
    const stateB = await b.load()
    // Shared rows and cursor…
    expect(stateB?.rows).toEqual(stateA?.rows)
    expect(stateB?.cursor).toEqual(stateA?.cursor)
    // …separate outbox state.
    expect(stateA?.outbox).toEqual([{ id: 5, name: 'sync.put', args: {} }])
    expect(stateA?.confirmedLmid).toBe(4)
    expect(stateB?.outbox).toEqual([{ id: 9, name: 'sync.del', args: {} }])
    expect(stateB?.confirmedLmid).toBe(8)

    await a.close()
    await b.close()
  })

  it('garbage-collects outbox records from long-dead clients on load', async () => {
    const factory = new IDBFactory()
    const dead = new IndexedDBSyncStore({ workspaceId: 'w1', clientId: 'dead-tab', indexedDB: factory, outboxMaxAgeMs: 0 })
    await dead.saveOutbox([{ id: 1, name: 'sync.put', args: {} }], 0)
    await dead.close()
    await new Promise((r) => setTimeout(r, 5)) // let the record age past maxAge 0

    // A different client loading with maxAge 0 treats everything stale.
    const live = new IndexedDBSyncStore({ workspaceId: 'w1', clientId: 'live-tab', indexedDB: factory, outboxMaxAgeMs: 0 })
    await live.load()
    await live.close()

    // The dead tab's record is gone; its own store now loads empty.
    const deadAgain = new IndexedDBSyncStore({ workspaceId: 'w1', clientId: 'dead-tab', indexedDB: factory })
    expect(await deadAgain.load()).toBeNull()
    await deadAgain.close()
  })

  it('reset wipes everything', async () => {
    const { store } = makeStore()
    await store.applyPoke(
      pokeUpdate({
        clear: true,
        ops: [{ op: 'put', tbl: 'todos', id: 't1', value: {} }],
        outbox: [{ id: 1, name: 'sync.put', args: {} }],
      }),
    )
    await store.reset()
    expect(await store.load()).toBeNull()
  })
})
