import { describe, expect, it } from 'vitest'
import { PingPeerError } from '@/modules/pingPeer/pingPeer'
import { parseSetModeArgs } from './setMode'

describe('parseSetModeArgs', () => {
    it('parses session id and mode', () => {
        expect(parseSetModeArgs(['7d55ed21', 'plan'])).toEqual({ help: false, sessionIdPrefix: '7d55ed21', mode: 'plan' })
        expect(parseSetModeArgs(['-h'])).toEqual({ help: true })
    })

    it('rejects flags and extra args', () => {
        expect(() => parseSetModeArgs(['7d55ed21', '--yolo'])).toThrow(PingPeerError)
        expect(() => parseSetModeArgs(['7d55ed21', 'plan', 'extra'])).toThrow(PingPeerError)
    })
})
