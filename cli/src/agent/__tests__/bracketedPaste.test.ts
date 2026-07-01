import { describe, expect, it } from 'vitest'
import { bracketPasteIfMultiline } from '../bracketedPaste'

const START = '\x1b[200~'
const END = '\x1b[201~'

describe('bracketPasteIfMultiline', () => {
    it('leaves a single-line message untouched', () => {
        expect(bracketPasteIfMultiline('hello world')).toBe('hello world')
    })

    it('wraps a multiline message in bracketed-paste markers', () => {
        expect(bracketPasteIfMultiline('line 1\nline 2')).toBe(`${START}line 1\nline 2${END}`)
    })

    it('wraps an attachment-formatted prompt (@path\\n\\ntext)', () => {
        expect(bracketPasteIfMultiline('@/tmp/a.png\n\ndescribe this'))
            .toBe(`${START}@/tmp/a.png\n\ndescribe this${END}`)
    })

    it('wraps a trailing newline (so it is not interpreted as a premature submit)', () => {
        expect(bracketPasteIfMultiline('text\n')).toBe(`${START}text\n${END}`)
    })

    it('leaves an empty string untouched', () => {
        expect(bracketPasteIfMultiline('')).toBe('')
    })
})
