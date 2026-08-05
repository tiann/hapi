import { afterEach, describe, expect, it } from 'vitest'
import { mirrorComposerSegments, serializeComposerSegments } from '@/lib/composerSegments'
import {
    insertLineBreakAtCaret,
    mirrorOffsetFromPoint,
    mirrorSelectionFromPoints,
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

    it('ignores the filler br browsers park in an emptied editor', () => {
        // Deleting the last character leaves Chromium/WebKit with `<br>` as the
        // sole child. Counting it made an empty composer hold "\n".
        const root = document.createElement('div')
        root.innerHTML = '<br>'
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('')
        expect(mirrorOffsetFromPoint(root, root, 0)).toBe(0)
        expect(mirrorOffsetFromPoint(root, root, 1)).toBe(0)

        const moz = document.createElement('div')
        moz.innerHTML = '<br type="_moz">'
        expect(serializeComposerSegments(segmentsFromEditor(moz))).toBe('')
    })

    it('keeps a trailing br that carries our caret pad (real trailing newline)', () => {
        // renderSegmentsToEditor maps "a\n" → text + <br> + ZWSP; the pad is
        // what separates a deliberate break from browser filler.
        const root = document.createElement('div')
        root.innerHTML = 'a<br>​'
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('a\n')
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
        Object.defineProperty(root, 'scrollHeight', { value: 120 })
        root.scrollTop = 10
        placeCaretAtEnd(root, hello)

        insertLineBreakAtCaret(root)

        const texts = Array.from(root.childNodes).map((n) => n.textContent ?? '')
        expect(texts).toContain(CARET_PAD)
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('hello\n')
        expect(root.scrollTop).toBe(120)
    })

    it('does not pad when there is meaningful content after the caret', () => {
        const root = document.createElement('div')
        document.body.appendChild(root)
        const text = document.createTextNode('helloworld')
        root.appendChild(text)
        Object.defineProperty(root, 'scrollHeight', { value: 120 })
        root.scrollTop = 10
        placeCaretInText(text, 5) // between hello|world

        insertLineBreakAtCaret(root)

        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('hello\nworld')
        expect(Array.from(root.childNodes).some((n) => n.textContent === CARET_PAD)).toBe(false)
        expect(root.scrollTop).toBe(10)
    })

    it('does not scroll for a nested middle-line break', () => {
        const root = document.createElement('div')
        document.body.appendChild(root)
        root.innerHTML = '<div>first</div><div>second</div>'
        Object.defineProperty(root, 'scrollHeight', { value: 120 })
        root.scrollTop = 10
        placeCaretAtEnd(root, root.firstElementChild!.firstChild as Text)

        insertLineBreakAtCaret(root)

        expect(root.scrollTop).toBe(10)
    })

    it('scrolls for a line break at the end of nested blocks', () => {
        const root = document.createElement('div')
        document.body.appendChild(root)
        root.innerHTML = '<div>first</div><div>second</div>'
        Object.defineProperty(root, 'scrollHeight', { value: 120 })
        root.scrollTop = 10
        placeCaretAtEnd(root, root.lastElementChild!.firstChild as Text)

        insertLineBreakAtCaret(root)

        expect(root.scrollTop).toBe(120)
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
        const mirrorLen = mirrorComposerSegments(segmentsFromEditor(root)).length
        // caret after 'b' → end of second text node
        const b = root.childNodes[2] as Text
        expect(b.nodeType).toBe(Node.TEXT_NODE)
        expect(mirrorOffsetFromPoint(root, b, b.textContent!.length)).toBe(mirrorLen)
    })

    it('keeps a direct br point at its explicit newline boundary', () => {
        const root = document.createElement('div')
        root.innerHTML = 'a<br>b'
        const br = root.childNodes[1] as HTMLElement

        expect(mirrorOffsetFromPoint(root, br, 0)).toBe(1)
        expect(mirrorOffsetFromPoint(root, root, 2)).toBe(2)
    })

    it('includes implicit block newlines for text and root-anchored points', () => {
        const root = document.createElement('div')
        root.innerHTML = '<div>one</div><div>two</div>'
        const two = root.lastChild!.firstChild as Text

        expect(mirrorComposerSegments(segmentsFromEditor(root))).toBe('one\ntwo')
        // The boundary before the second block is the visual start of "two",
        // after the implicit newline rather than after "one".
        expect(mirrorOffsetFromPoint(root, root, 1)).toBe(4)
        expect(mirrorOffsetFromPoint(root, two, two.length)).toBe(7)
        expect(mirrorOffsetFromPoint(root, root, root.childNodes.length)).toBe(7)
    })

    it('normalizes a text descendant of a session chip to atom boundaries', () => {
        const root = document.createElement('div')
        root.innerHTML =
            'before <span contenteditable="false" data-composer-mention="session" data-session-id="aaa" data-session-title="Peer A"><strong>@Peer A</strong></span> after'
        const chip = root.children[0] as HTMLElement
        const visibleChipText = chip.firstChild!.firstChild as Text
        const mirror = mirrorComposerSegments(segmentsFromEditor(root))

        expect(mirror).toBe('before \uFFFC after')
        expect(mirrorOffsetFromPoint(root, visibleChipText, 0)).toBe(7)
        expect(mirrorOffsetFromPoint(root, visibleChipText, visibleChipText.length)).toBe(8)
        expect(mirrorOffsetFromPoint(root, visibleChipText, visibleChipText.length)).not.toBe(mirror.length)
    })

    it('keeps forward and reverse cross-chip selections in one mirror coordinate space', () => {
        const root = document.createElement('div')
        root.innerHTML =
            'one <span contenteditable="false" data-composer-mention="session" data-session-id="aaa" data-session-title="Peer A">@Peer A</span> two <span contenteditable="false" data-composer-mention="session" data-session-id="bbb" data-session-title="Peer B"><em>@Peer B</em></span> three'
        const firstChipText = root.children[0]!.firstChild as Text
        const secondChipText = root.children[1]!.firstChild!.firstChild as Text

        const forward = mirrorSelectionFromPoints(
            root,
            firstChipText,
            0,
            secondChipText,
            secondChipText.length
        )
        const reverse = mirrorSelectionFromPoints(
            root,
            secondChipText,
            secondChipText.length,
            firstChipText,
            0
        )

        expect(forward).toEqual({ start: 4, end: 11 })
        expect(reverse).toEqual(forward)
    })

    it('uses the same offsets across nested non-empty block wrappers', () => {
        const root = document.createElement('div')
        root.innerHTML = '<div>one<div><p>two</p><p>three</p></div></div><div>four</div>'
        const one = root.firstChild!.firstChild as Text
        const two = (root.firstChild!.childNodes[1] as HTMLElement).firstChild!.firstChild as Text
        const four = root.lastChild!.firstChild as Text
        const mirror = mirrorComposerSegments(segmentsFromEditor(root))

        expect(mirror).toBe('one\ntwo\nthree\nfour')
        expect(mirrorOffsetFromPoint(root, two, 0)).toBe(4)
        expect(mirrorOffsetFromPoint(root, root, 1)).toBe(14)
        expect(mirrorSelectionFromPoints(root, one, 1, four, four.length)).toEqual({
            start: 1,
            end: mirror.length,
        })
    })

    it('keeps bare empty block wrappers out of the wire mirror', () => {
        const root = document.createElement('div')
        root.innerHTML = '<div>one</div><div></div><div>two</div>'

        expect(mirrorComposerSegments(segmentsFromEditor(root))).toBe('one\ntwo')
        // Both boundaries around a bare empty wrapper normalize to the next
        // visible block start; the wrapper itself creates no new mirror slot.
        expect(mirrorOffsetFromPoint(root, root, 1)).toBe(4)
        expect(mirrorOffsetFromPoint(root, root, 2)).toBe(4)
        const empty = root.children[1] as HTMLElement
        expect(mirrorOffsetFromPoint(root, empty, 0)).toBe(4)

        const trailingEmpty = document.createElement('div')
        trailingEmpty.innerHTML = '<div>one</div><div></div>'
        expect(mirrorComposerSegments(segmentsFromEditor(trailingEmpty))).toBe('one')
        expect(mirrorOffsetFromPoint(trailingEmpty, trailingEmpty.children[1]!, 0)).toBe(3)

        const leadingEmpty = document.createElement('div')
        leadingEmpty.innerHTML = '<div></div><div>two</div>'
        expect(mirrorOffsetFromPoint(leadingEmpty, leadingEmpty.children[0]!, 0)).toBe(0)

        const nestedEmpty = document.createElement('div')
        nestedEmpty.innerHTML = '<div>one<div></div><div>two</div></div>'
        const nested = nestedEmpty.firstChild as HTMLElement
        expect(mirrorOffsetFromPoint(nestedEmpty, nested.children[0]!, 0)).toBe(4)

        const sectionWrapped = document.createElement('div')
        sectionWrapped.innerHTML = '<div>one</div><section><div></div></section><div>two</div>'
        const section = sectionWrapped.children[1] as HTMLElement
        const sectionInner = section.firstElementChild!
        expect(mirrorOffsetFromPoint(sectionWrapped, sectionWrapped, 1)).toBe(4)
        expect(mirrorOffsetFromPoint(sectionWrapped, sectionWrapped, 2)).toBe(4)
        expect(mirrorOffsetFromPoint(sectionWrapped, section, 0)).toBe(4)
        expect(mirrorOffsetFromPoint(sectionWrapped, sectionInner, 0)).toBe(4)

        const listWrapped = document.createElement('div')
        listWrapped.innerHTML = '<div>one</div><ul><li></li></ul><div>two</div>'
        const list = listWrapped.children[1] as HTMLElement
        const listItem = list.firstElementChild!
        expect(mirrorOffsetFromPoint(listWrapped, listWrapped, 1)).toBe(4)
        expect(mirrorOffsetFromPoint(listWrapped, listWrapped, 2)).toBe(4)
        expect(mirrorOffsetFromPoint(listWrapped, list, 0)).toBe(4)
        expect(mirrorOffsetFromPoint(listWrapped, listItem, 0)).toBe(4)

        const inline = document.createElement('div')
        inline.innerHTML = '<span></span>one<span></span>two'
        expect(mirrorComposerSegments(segmentsFromEditor(inline))).toBe('onetwo')
        expect(mirrorOffsetFromPoint(inline, inline.children[0]!, 0)).toBe(0)
        expect(mirrorOffsetFromPoint(inline, inline.children[1]!, 0)).toBe(3)
        expect(mirrorOffsetFromPoint(inline, inline, 2)).toBe(3)
    })
})
