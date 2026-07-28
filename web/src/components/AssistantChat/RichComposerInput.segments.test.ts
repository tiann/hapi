import { describe, expect, it } from 'vitest'
import { serializeComposerSegments } from '@/lib/composerSegments'
import { mirrorOffsetFromPoint, segmentsFromEditor } from './RichComposerInput'

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

    it('preserves newlines inside pasted wrapper blocks (nested p/li)', () => {
        const root = document.createElement('div')
        root.innerHTML = '<div><p>a</p><p>b</p></div>'
        expect(serializeComposerSegments(segmentsFromEditor(root))).toBe('a\nb')

        const list = document.createElement('div')
        list.innerHTML = '<ul><li>one</li><li>two</li></ul>'
        expect(serializeComposerSegments(segmentsFromEditor(list))).toBe('one\ntwo')
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
})
