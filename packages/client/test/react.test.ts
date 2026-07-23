import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SyncClient } from '../src/client'
import { useSyncStatus } from '../src/react'
import { FakeSocket } from './fake-socket'
import { testApp } from './test-schema'

function makeClient(autoStart: boolean) {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: 'client-a',
    autoStart,
    app: testApp,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  return { client, sockets }
}

function StatusProbe({ client }: { client: SyncClient<any, any> }) {
  return createElement('span', null, useSyncStatus(client))
}

describe('useSyncStatus', () => {
  it('reads the current status (server snapshot path, so SSR works)', () => {
    const { client } = makeClient(false)
    expect(renderToString(createElement(StatusProbe, { client }))).toBe('<span>idle</span>')

    client.start()
    expect(renderToString(createElement(StatusProbe, { client }))).toBe('<span>connecting</span>')
    client.stop()
  })

  it('subscribes through the unbound subscribeStatus property', () => {
    const { client, sockets } = makeClient(true)
    const seen: string[] = []
    // The hook passes client.subscribeStatus unbound to useSyncExternalStore;
    // prove the property works detached from the instance.
    const { subscribeStatus } = client
    const unsubscribe = subscribeStatus((status) => seen.push(status))
    sockets[0]!.open()
    expect(seen).toEqual(['syncing'])
    unsubscribe()
    client.stop()
  })
})
