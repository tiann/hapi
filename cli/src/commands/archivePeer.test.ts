import { describe, expect, it } from 'vitest'
import { parseArchivePeerArgs } from './archivePeer'

describe('archive-peer arguments', () => {
    it('requires explicit --self for current-chat selection', () => {
        expect(parseArchivePeerArgs(['--self'])).toEqual({ help: false, self: true })
        expect(parseArchivePeerArgs(['reviewer-uuid'])).toEqual({ help: false, self: false, sessionIdPrefix: 'reviewer-uuid' })
    })
    it.each([['--self', 'another'], ['first', 'second'], ['--force'], ['--delete']])('rejects conflicting or unsupported arguments %j', (...args) => {
        expect(() => parseArchivePeerArgs(args)).toThrow()
    })
})
