import { afterEach, describe, expect, it } from 'vitest'
import { serializeComposerSegments } from '@/lib/composerSegments'
import {
    insertLineBreakAtCaret,
    mirrorOffsetFromPoint,
    segmentsFromEditor,
} from './RichComposerInput'

const CARET_PAD = '\u200B'

function placeCaretAtEnd(root: HTMLElement, textNode: Text) {
    const range = document.createRange()
    range.setStart(textNode, textNode.textContent?.length ?? 0)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
}

function placeCaretInText(textNode: Text, offset: number) {
    const range = document.createRange()
    range.setStart(textNode, offset)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
}

describe('segmentsFromEditor', () => {
    it('preserves newlines between Chromium block divs (Enter-inserts-newline)', () => {
        const root = document.createElement('div')
        root.innerHTML = '<div>line1</div><div>line2</div>'
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('line1\nline2')
    })

    it('maps br to newlines', () => {
        const root = document.createElement('div')
        root.innerHTML = 'a<br>b'
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('a\nb')
    })

    it('preserves blank-line endings from renderSegments (br+br+pad)', () => {
        // renderSegmentsToEditor maps "...\n\n" → text + <br> + <br> + ZWSP.
        // Must not strip a real trailing blank line on re-serialize.
        const root = document.createElement('div')
        root.appendChild(document.createTextNode('a'))
        root.appendChild(document.createElement('br'))
        root.appendChild(document.createElement('br'))
        root.appendChild(document.createTextNode('\u200B'))
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('a\n\n')
    })

    it('serializes Chromium-style LF text nodes without inventing extras', () => {
        // plaintext-only insertLineBreak used to leave hello + \\n + \\n text nodes.
        const root = document.createElement('div')
        root.appendChild(document.createTextNode('hello'))
        root.appendChild(document.createTextNode('\n'))
        root.appendChild(document.createTextNode('\n'))
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('hello\n\n')
    })

    it('strips caret-pad ZWSP used for trailing linebreak line-boxes', () => {
        const root = document.createElement('div')
        root.appendChild(document.createTextNode('a'))
        root.appendChild(document.createElement('br'))
        root.appendChild(document.createTextNode('\u200B'))
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('a\n')
    })

    it('keeps session atoms across block breaks', () => {
        const root = document.createElement('div')
        root.innerHTML =
            '<div>see <span contenteditable="false" data-composer-mention="session" data-session-id="aaa" data-session-title="Peer A">@Peer A</span></div><div>next</div>'
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe(
            'see [Peer A](/sessions/aaa)\nnext'
        )
    })

    it('serializes chip with full UUID — never chip-visible @title alone', () => {
        const sessionId = '7d55ed21-8a9f-4309-b4f8-30069df36b4b'
        const title = 'hub runner version governance'
        const root = document.createElement('div')
        root.innerHTML =
            `see <span contenteditable="false" data-composer-mention="session" data-session-id="${sessionId}" data-session-title="${title}">@${title}</span>`
        const wire = serializeComposerSegments(segmentsFromEditor(root))
        expect(wire).toBe(`see [${title}](/sessions/${sessionId})`)
        expect(wire).toContain(sessionId)
        expect(wire.includes(`@${title}`)).toBe(false)
    })

    it('drops orphan session chips missing data-session-id (no title-only wire)', () => {
        const root = document.createElement('div')
        root.innerHTML =
            'see <span contenteditable="false" data-composer-mention="session" data-session-title="orphan">@orphan</span> x'
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('see  x')
    })

    it('preserves newlines inside pasted wrapper blocks (nested p/li)', () => {
        const root = document.createElement('div')
        root.innerHTML = '<div><p>a</p><p>b</p></div>'
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('a\nb')

        const list = document.createElement('div')
        list.innerHTML = '<ul><li>one</li><li>two</li></ul>'
        expect(serializeComposerSegments(segmentsFromEditor(list))).toBe('one\ntwo')
    })
})

describe('insertLineBreakAtCaret', () => {
    afterEach(() => {
        document.body.replaceChildren()
        window.getSelection()?.removeAllRanges()
    })

    it('inserts CARET_PAD after EOL break even when insertNode leaves an empty sibling', () => {
        const root = document.createElement('div')
        document.body.appendChild(root)
        const hello = document.createTextNode('hello')
        root.appendChild(hello)
        placeCaretAtEnd(root, hello)

        insertLineBreakAtCaret(root)

        const texts = Array.from(root.childNodes).map((n) => n.textContent ?? '')
        expect(texts).toContain(CARET_PAD)
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('hello\n')
    })

    it('does not pad when there is meaningful content after the caret', () => {
        const root = document.createElement('div')
        document.body.appendChild(root)
        const text = document.createTextNode('helloworld')
        root.appendChild(text)
        placeCaretInText(text, 5) // between hello|world

        insertLineBreakAtCaret(root)

        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('hello\nworld')
        expect(Array.from(root.childNodes).some((n) => n.textContent === CARET_PAD)).toBe(false)
    })
})

describe('mirrorOffsetFromPoint', () => {
    it('maps root-anchored caret before a leading chip to offset 0', () => {
        const root = document.createElement('div')
        root.innerHTML =
            '<span contenteditable="false" data-composer-mention="session" data-session-id="aaa" data-session-title="Peer A">@Peer A</span> after'
        expect(mirrorOffsetFromPoint(root, root, 0)).toBe(0)
        expect(mirrorOffsetFromPoint(root, root, 1)).toBe(1)
    })

    it('matches segmentsFromEditor length for br-separated lines', () => {
        const root = document.createElement('div')
        root.innerHTML = 'a<br>b'
        const mirrorLen = serializeComposerSegments(segmentsFromEditor(root)).length
        // caret after 'b' → end of second text node
        const b = root.childNodes[2] as Text
        expect(b.nodeType).toBe(Node.TEXT_NODE)
        expect(mirrorOffsetFromPoint(root, b, b.textContent!.length)).toBe(mirrorLen)
    })
})
