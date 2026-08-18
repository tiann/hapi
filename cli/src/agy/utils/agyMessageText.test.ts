import { describe, expect, it } from 'vitest'
import { isSameAgyResponse } from './agyMessageText'

describe('isSameAgyResponse', () => {
    it('matches identical renderings', () => {
        expect(isSameAgyResponse('hello', 'hello')).toBe(true)
    })

    it('matches a delta rendering whose multi-byte characters were mangled', () => {
        // One 3-byte CJK character split across two `text_delta` fields arrives
        // as three replacement characters (1 orphan byte + 2 orphan bytes).
        const streamed = '这是一段���较长的中文回答。'
        const authoritative = '这是一段比较长的中文回答。'

        expect(streamed).not.toBe(authoritative)
        expect(isSameAgyResponse(streamed, authoritative)).toBe(true)
    })

    it('matches several independent mangled characters', () => {
        expect(isSameAgyResponse('第���段与第���段', '第一段与第二段')).toBe(true)
    })

    it('does not treat a genuinely different answer as the same', () => {
        expect(isSameAgyResponse('第���段落', '完全不同的另一段回答')).toBe(false)
        expect(isSameAgyResponse('narration', 'the final answer')).toBe(false)
    })

    it('does not match when only one side is clean', () => {
        // No corruption to explain the difference: a trailing sentence is a
        // real difference, not a decoding artifact.
        expect(isSameAgyResponse('答案', '答案。还有更多内容')).toBe(false)
    })

    it('treats regex metacharacters in the answer literally', () => {
        expect(isSameAgyResponse('a.c���(x)[1]', 'a.c段(x)[1]')).toBe(true)
        expect(isSameAgyResponse('a.c���(x)[1]', 'aXc段(x)[1]')).toBe(false)
    })
})
