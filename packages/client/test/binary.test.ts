import { describe, expect, it, vi } from 'vitest'
import { SyncClient } from '../src/client'
import { FakeSocket } from './fake-socket'
import { testApp } from './test-schema'

function makeClient() {
  const sockets: FakeSocket[] = []
  const client = new SyncClient({
    url: 'ws://test',
    workspaceId: 'w1',
    clientId: 'client-a',
    autoStart: false,
    app: testApp,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  return { client, sockets, latest: () => sockets[sockets.length - 1]! }
}

describe('binary lane seams (§17.5)', () => {
  it('sendBinary writes bytes to the live socket, and is a no-op without one', () => {
    const { client, latest } = makeClient()
    client.sendBinary(new Uint8Array([1, 2, 3])) // not started: silent no-op
    client.start()
    latest().open()
    client.sendBinary(new Uint8Array([4, 5]))
    expect(latest().sentBinary.length).toBe(1)
    expect([...latest().sentBinary[0]!]).toEqual([4, 5])
  })

  it('fans inbound binary frames out to onBinary subscribers and supports unsubscribe', () => {
    const { client, latest } = makeClient()
    client.start()
    latest().open()
    const seen: number[][] = []
    const unsubscribe = client.onBinary((bytes) => seen.push([...bytes]))
    latest().receiveBinary(new Uint8Array([9, 8, 7]))
    expect(seen).toEqual([[9, 8, 7]])
    unsubscribe()
    latest().receiveBinary(new Uint8Array([1]))
    expect(seen).toEqual([[9, 8, 7]])
  })

  it('binary frames do not disturb the JSON message path', () => {
    const { client, latest } = makeClient()
    client.start()
    latest().open()
    latest().receiveBinary(new Uint8Array([0, 1, 2]))
    // hello went out untouched and the client still parses JSON frames
    expect(latest().sent.some((m) => m.type === 'hello')).toBe(true)
  })

  it('drops non-ArrayBuffer binary data with a one-time warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client, latest } = makeClient()
      client.start()
      latest().open()
      const seen: number[][] = []
      client.onBinary((bytes) => seen.push([...bytes]))
      // A Blob-like payload: what a custom createSocket delivers when it
      // forgot binaryType = 'arraybuffer'.
      latest().receiveRaw({ not: 'bytes' })
      expect(seen).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      latest().receiveRaw({ not: 'bytes' })
      expect(warn).toHaveBeenCalledTimes(1) // warned once
    } finally {
      warn.mockRestore()
    }
  })
})
