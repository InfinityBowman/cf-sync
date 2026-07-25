import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { TestClient } from '../harness'

/**
 * Sentry-wrapper compatibility (L5). `instrumentDurableObjectWithSentry` is a
 * Proxy whose `construct` trap swaps `ctx` for an instrumented clone (storage
 * and `sql.exec` become span-wrapping proxies) and reassigns `fetch`, `alarm`,
 * `webSocketMessage`, `webSocketClose`, and `webSocketError` as own properties
 * shadowing the engine's prototype methods.
 *
 * Both moves sit on load-bearing engine behavior, so this is verification
 * against the real package rather than a mock: every hibernation handler must
 * still be dispatched, and invariant 3's synchronous commit-then-send must
 * survive the wrapper's scope/span machinery.
 */

const workspace = (name: string) => `sentry-${name}-${Date.now()}`

function stubFor(workspaceId: string) {
  return env.SENTRY_WORKSPACE.get(env.SENTRY_WORKSPACE.idFromName(workspaceId))
}

/** The next relayed `presence` frame about `clientId`, skipping snapshots/polls. */
async function nextPresenceFrom(client: TestClient, clientId: string) {
  for (;;) {
    const frame = await client.nextPresence()
    if (frame.type === 'presence' && frame.clientId === clientId) return frame
  }
}

describe('instrumentDurableObjectWithSentry(createWorkspaceDO(app))', () => {
  it('serves a full session: upgrade, hello, mutate, poke', async () => {
    const id = workspace('session')
    const c1 = await TestClient.connect(id, 'c1')

    // fetch → the upgrade path, through the wrapper's request instrumentation.
    await c1.syncOnce()

    // webSocketMessage → push, and the commit path underneath it: the
    // instrumented ctx.storage.sql must still execute inside transactionSync.
    c1.push([
      { id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { title: 'wrapped' } } },
      { id: 2, name: 'counter.increment', args: { id: 'a', by: 5 } },
    ])
    await c1.pokeUntilLmid(2)

    expect(c1.rows.get('todos/t1')).toEqual({ title: 'wrapped' })
    expect(c1.rows.get('counters/a')).toEqual({ value: 5 })
    c1.close()
  })

  it('commits and sends synchronously — invariant 3 survives the wrapper', async () => {
    const id = workspace('sync')
    const c1 = await TestClient.connect(id, 'c1')
    await c1.syncOnce()

    // The public class type deliberately hides the handlers (traffic goes
    // through the routers, never instance methods) — this drill is the one
    // place that must call one directly, to observe the boundary.
    type HibernationHandlers = { webSocketMessage(ws: WebSocket, raw: string): Promise<void> }

    await runInDurableObject(stubFor(id), async (instance, state) => {
      const socket = state.getWebSockets()[0]
      expect(socket).toBeDefined()
      const rowCount = () =>
        state.storage.sql.exec(`SELECT id FROM rows WHERE tbl = 'todos' AND id = 'inline'`).toArray().length
      expect(rowCount()).toBe(0) // the assertion below is about this call, not prior state

      const pending = (instance as unknown as HibernationHandlers).webSocketMessage(
        socket!,
        JSON.stringify({
          type: 'push',
          mutations: [{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'inline', data: { n: 1 } } }],
        }),
      )

      // Read storage before yielding. If the wrapper deferred the handler to a
      // microtask — an `await` anywhere ahead of Reflect.apply — the row would
      // not be here yet, and every "no await between reading state and sending
      // frames" guarantee in the engine would be off by one turn.
      expect(rowCount()).toBe(1)

      await pending
    })
    c1.close()
  })

  it('fans out to other sockets and dispatches webSocketClose', async () => {
    const id = workspace('fanout')
    const c1 = await TestClient.connect(id, 'c1')
    const c2 = await TestClient.connect(id, 'c2')
    await c1.syncOnce()
    await c2.syncOnce()

    // Presence lives in DO memory keyed by socket, so it reads both the relay
    // and the close handler's cleanup.
    c1.presence({ name: 'one' })
    c2.presence({ name: 'two' })
    // Past the presencePeers snapshot each socket gets at ready, to the relay.
    const seen = await nextPresenceFrom(c2, 'c1')
    expect(seen.state).toEqual({ name: 'one', label: 'peer' })

    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 'shared', data: { title: 'broadcast' } } }])
    await c2.pokeUntilVersion(1)
    expect(c2.rows.get('todos/shared')).toEqual({ title: 'broadcast' })

    // webSocketClose → the departing peer's presence is retracted (null state).
    c1.close()
    expect((await nextPresenceFrom(c2, 'c1')).state).toBeNull()
    c2.close()
  })

  it('re-wraps handlers on a hibernation wake, on the surviving socket', async () => {
    const id = workspace('wake')
    const c1 = await TestClient.connect(id, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'counter.increment', args: { id: 'a', by: 3 } }])
    await c1.pokeUntilLmid(1)

    // The production hibernation lifecycle: instance memory gone, sockets and
    // attachments intact (unlike state.abort(), which kills them). The wake
    // re-runs Sentry's construct trap, which must re-shadow the prototype
    // handlers on the new instance or the surviving socket goes deaf.
    await evictDurableObject(stubFor(id))

    // Same socket, no reconnect — this frame is delivered to a handler that
    // only exists because the wrapper rebuilt it.
    c1.push([{ id: 2, name: 'counter.increment', args: { id: 'a', by: 4 } }])
    await c1.pokeUntilLmid(2)
    // Read-modify-write across the wake: state came back from SQL through the
    // instrumented storage proxy, not from lost instance memory.
    expect(c1.rows.get('counters/a')).toEqual({ value: 7 })
    // Proof the object really was evicted rather than served warm: only the
    // constructor emits presencePoll, and it does so on a wake with live
    // sockets. Without it this test would pass on an instance that never died.
    let sawPoll = false
    // Past this socket's own presencePeers snapshot from connect time.
    while (!sawPoll) sawPoll = (await c1.nextPresence()).type === 'presencePoll'
    expect(sawPoll).toBe(true)
    c1.close()
  })

  it('dispatches the maintenance alarm', async () => {
    const id = workspace('alarm')
    const c1 = await TestClient.connect(id, 'c1')
    await c1.syncOnce()
    c1.push([{ id: 1, name: 'sync.put', args: { tbl: 'todos', id: 't1', data: { n: 1 } } }])
    await c1.pokeUntilLmid(1)
    c1.close()

    // The engine arms a maintenance alarm at init; Sentry wraps `alarm` with a
    // new-trace span and a waitUntil teardown. It must still run, and the
    // workspace must still be serving afterwards.
    expect(await runDurableObjectAlarm(stubFor(id))).toBe(true)

    const c2 = await TestClient.connect(id, 'c2')
    const catchUp = await c2.syncOnce()
    expect(catchUp.patch).toContainEqual(
      expect.objectContaining({ op: 'put', tbl: 'todos', id: 't1' }),
    )
    c2.close()
  })
})
