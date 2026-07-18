import { describe, expect, it } from 'bun:test'
import { createRequire } from 'node:module'
import { DEFAULT_SOCKET_IO_MAX_HTTP_BUFFER_BYTES } from './server'

// Resolve from Socket.IO itself so this exercises the parser used at runtime
// under Bun's isolated linker instead of an independently hoisted test copy.
const requireFromSocketIo = createRequire(createRequire(import.meta.url).resolve('socket.io/package.json'))
const { Decoder } = requireFromSocketIo('socket.io-parser')

describe('socket server limits', () => {
    it('allows websocket frames large enough for 30MB inline agent attachments', () => {
        expect(DEFAULT_SOCKET_IO_MAX_HTTP_BUFFER_BYTES).toBeGreaterThanOrEqual(45 * 1024 * 1024)
    })

    it('rejects more than ten declared binary attachments before buffering them', () => {
        const oversized = new Decoder()
        expect(() => oversized.add('511-["event",{"_placeholder":true,"num":0}]')).toThrow(/too many attachments/i)
        oversized.destroy()

        const boundary = new Decoder()
        expect(() => boundary.add('510-["event",{"_placeholder":true,"num":0}]')).not.toThrow()
        boundary.destroy()
    })
})
