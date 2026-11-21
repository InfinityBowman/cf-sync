import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../src/client'
import { IndexedDBSyncStore } from '../src/idb-store'
import { testApp } from './test-schema'
import { FakeSocket } from './fake-socket'

/** A LockManager where `takenByOtherTab` names locks some other live tab holds. */
function fakeLocks(takenByOtherTab: string[] = []) {
  const held = new Set(takenByOtherTab)
  return {
    held,
    request(name: string, _opts: { ifAvailable: boolean }, cb: (lock: object | null) => unknown) {
      if (held.has(name)) return Promise.resolve(cb(null))
      held.add(name)
      return Promise.resolve(cb({ name }))
    },
  }
}

function stubTab(storedIds: Record<string, string>, locks: ReturnType<typeof fakeLocks>) {
  const backing = new Map(Object.entries(storedIds))
  vi.stubGlobal('document', {})
  vi.stubGlobal('navigator', { locks })
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
  })
  return backing
}

function makeClient(workspaceId: string, overrides: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) {
  const urls: string[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId,
    autoStart: false,
    app: testApp,
    createSocket: (url) => {
      urls.push(url)
      return new FakeSocket()
    },
    ...overrides,
  })
  return { client, urls }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('duplicated tab', () => {
  it('mints a fresh clientId when another live tab holds the stored one', async () => {
    const locks = fakeLocks(['cf-sync:client:orig-1'])
    const storage = stubTab({ 'cf-sync:client-id:dup-1': 'orig-1' }, locks)

    const { client, urls } = makeClient('dup-1')
    client.start()
    await settle()

    expect(client.clientId).not.toBe('orig-1')
    expect(urls).toEqual([`ws://test/sync/dup-1?clientId=${client.clientId}`])
    // A reload of the duplicate keeps its own new id.
    expect(storage.get('cf-sync:client-id:dup-1')).toBe(client.clientId)
    expect(locks.held.has(`cf-sync:client:${client.clientId}`)).toBe(true)
  })

  it('keeps the stored clientId on a reload, where no live tab holds it', async () => {
    const locks = fakeLocks()
    stubTab({ 'cf-sync:client-id:reload-1': 'orig-2' }, locks)

    const { client, urls } = makeClient('reload-1')
    client.start()
    await settle()

    expect(client.clientId).toBe('orig-2')
    expect(urls).toEqual(['ws://test/sync/reload-1?clientId=orig-2'])
  })

  it('reuses the id for a later client in the same tab', async () => {
    const locks = fakeLocks()
    stubTab({ 'cf-sync:client-id:same-1': 'orig-3' }, locks)

    const first = makeClient('same-1').client
    first.start()
    await settle()
    await first.destroy()

    const { client: again, urls } = makeClient('same-1')
    again.start()
    await settle()
    expect(again.clientId).toBe('orig-3')
    expect(urls).toEqual(['ws://test/sync/same-1?clientId=orig-3'])
  })

  it("does not replay the original tab's outbox", async () => {
    const factory = new IDBFactory()
    const original = new IndexedDBSyncStore({ workspaceId: 'dup-2', clientId: 'orig-4', indexedDB: factory })
    await original.applyPoke({
      ops: [{ op: 'put', tbl: 'todos', id: 't1', value: { title: 'shared row' } }],
      clear: true,
      cursor: { backendId: 'b1', version: 1 },
      schemaVersion: 1,
      confirmedLmid: 0,
      outbox: [{ id: null, name: 'sync.put', args: {} }],
    })
    await original.close()

    stubTab({ 'cf-sync:client-id:dup-2': 'orig-4' }, fakeLocks(['cf-sync:client:orig-4']))
    vi.stubGlobal('indexedDB', factory)
    const { client } = makeClient('dup-2', { persist: true })
    client.start()
    await settle()

    expect(client.clientId).not.toBe('orig-4')
    expect(client.pending).toBe(0)
    await client.destroy()

    const reread = new IndexedDBSyncStore({ workspaceId: 'dup-2', clientId: 'orig-4', indexedDB: factory })
    expect((await reread.load())?.outbox).toEqual([{ id: null, name: 'sync.put', args: {} }])
    await reread.close()
  })

  it('leaves an explicitly configured clientId alone', async () => {
    stubTab({}, fakeLocks(['cf-sync:client:explicit']))
    const { client, urls } = makeClient('explicit-1', { clientId: 'explicit' })
    client.start()
    expect(urls).toEqual(['ws://test/sync/explicit-1?clientId=explicit'])
  })
})
