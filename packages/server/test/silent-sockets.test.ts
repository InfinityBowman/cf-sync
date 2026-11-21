import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestClient } from './harness'

// ARCHITECTURE.md#connections-and-lifecycle: a socket the edge dropped without telling the DO is
// closed once it has gone 150s without a keepalive, so a woken object can hibernate again.
describe('silent sockets', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes a socket with no ping in 150s and keeps the fresh one', async () => {
    const workspace = `silent-${Date.now()}`
    const gone = await TestClient.connect(workspace, 'gone')
    await gone.syncOnce()

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 151_000)

    // Any request to the object sweeps; this connect is the one that finds the silent socket.
    const fresh = await TestClient.connect(workspace, 'fresh')
    await fresh.syncOnce()

    expect(await gone.waitClose()).toEqual({ code: 4000, reason: 'no ping' })
    expect(fresh.closeEvent).toBeNull()
    fresh.close()
  })
})
