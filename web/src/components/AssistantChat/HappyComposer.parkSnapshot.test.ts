import { describe, expect, it } from 'vitest'
import { composerParkSnapshotUnchanged } from './HappyComposer'

describe('composerParkSnapshotUnchanged', () => {
    it('returns true when text and attachment ids match', () => {
        const snapshot = {
            text: 'hello',
            attachments: [{ id: 'a1' }, { id: 'a2' }],
        }
        expect(composerParkSnapshotUnchanged(snapshot, {
            text: 'hello',
            attachments: [{ id: 'a1' }, { id: 'a2' }],
        })).toBe(true)
    })

    it('returns false when text or attachments changed during park', () => {
        const snapshot = {
            text: 'hello',
            attachments: [{ id: 'a1' }],
        }
        expect(composerParkSnapshotUnchanged(snapshot, {
            text: 'hello world',
            attachments: [{ id: 'a1' }],
        })).toBe(false)
        expect(composerParkSnapshotUnchanged(snapshot, {
            text: 'hello',
            attachments: [{ id: 'a1' }, { id: 'a2' }],
        })).toBe(false)
        expect(composerParkSnapshotUnchanged(snapshot, {
            text: 'hello',
            attachments: [{ id: 'a2' }],
        })).toBe(false)
    })
})
