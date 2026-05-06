import { describe, expect, it } from 'vitest'
import { findActiveWord } from './findActiveWord'

describe('findActiveWord', () => {
    it('finds a prefixed word at the current cursor token', () => {
        expect(findActiveWord('run $rev', { start: 8, end: 8 }, ['$'])).toMatchObject({
            activeWord: '$rev',
            offset: 4,
        })
    })

    it('does not keep an earlier dollar token active after a space', () => {
        expect(findActiveWord('$review 检查代', { start: 12, end: 12 }, ['$'])).toBeUndefined()
    })

    it('does not keep an earlier slash token active after a space', () => {
        expect(findActiveWord('/status continue', { start: 16, end: 16 }, ['/'])).toBeUndefined()
    })
})
