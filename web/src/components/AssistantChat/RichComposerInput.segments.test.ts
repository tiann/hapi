import { describe, expect, it } from 'vitest'
import { serializeComposerSegments } from '@/lib/composerSegments'
import { segmentsFromEditor } from './RichComposerInput'

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
})
