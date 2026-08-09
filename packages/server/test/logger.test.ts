import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rolloutConfig } from './fixture/worker'
import { TestClient } from './harness'

// Every diagnostic names the workspace it came from: instances of one DO class
// share an isolate, so an unattributed line leaves an operator unable to tell
// whose sync broke. The hardest case is a wake whose initialization failed —
// the meta row is exactly what could not be loaded, so the label has to come
// from the DO id instead.

afterEach(() => {
  delete rolloutConfig.logger
  vi.restoreAllMocks()
})

describe('injected engine logger', () => {
  it('attributes an init failure to its workspace with no meta row to read', async () => {
    const workspace = `logger-init-fail-${Date.now()}`
    const logger = vi.fn()
    rolloutConfig.logger = logger

    const c1 = await TestClient.connect(workspace, 'c1', '/rollout')
    await c1.syncOnce()
    c1.close()
    expect(logger).not.toHaveBeenCalled()

    // Corrupt the stored version the way pre-numeric workspaces are, then
    // evict so the next wake fails initialization against it.
    const stub = env.ROLLOUT.get(env.ROLLOUT.idFromName(workspace))
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(`UPDATE meta SET schema_version = 'demo-1' WHERE id = 1`)
    })
    await evictDurableObject(stub, { webSockets: 'close' })

    await expect(TestClient.connect(workspace, 'c1', '/rollout')).rejects.toThrow('upgrade failed: 503')

    expect(logger).toHaveBeenCalledTimes(1)
    const [level, message, context, detail] = logger.mock.calls[0]!
    expect(level).toBe('error')
    expect(String(message)).toContain('workspace initialization failed')
    expect(context).toEqual({ workspaceId: workspace })
    expect(detail).toBeInstanceOf(Error)
  })
})
