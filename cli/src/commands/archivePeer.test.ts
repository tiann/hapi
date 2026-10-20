import { describe, expect, it } from 'vitest'
import { ArchivePeerError } from '@/modules/archivePeer/archivePeer'
import { parseArchivePeerArgs } from './archivePeer'

describe('parseArchivePeerArgs', () => {
    it('parses positional session id prefix', () => {
        expect(parseArchivePeerArgs(['05d9f0f2'])).toEqual({
            help: false,
            sessionIdPrefix: '05d9f0f2'
        })
    })

    it('parses --help', () => {
        expect(parseArchivePeerArgs(['--help']).help).toBe(true)
    })

    it('rejects unknown flags', () => {
        expect(() => parseArchivePeerArgs(['--host', 'evil'])).toThrow(ArchivePeerError)
    })

    it('rejects extra positional args', () => {
        expect(() => parseArchivePeerArgs(['abc', 'extra'])).toThrow(ArchivePeerError)
    })
})
