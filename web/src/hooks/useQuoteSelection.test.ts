import { describe, expect, it, beforeEach } from 'vitest'
import { resolveQuotableSelection } from './useQuoteSelection'

function setup(html: string) {
    document.body.innerHTML = `<div id="thread">${html}</div>`
    return document.getElementById('thread')!
}

function selectContents(el: Element): Selection {
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    return sel
}

describe('resolveQuotableSelection', () => {
    beforeEach(() => { document.body.innerHTML = '' })

    it('returns null when there is no selection', () => {
        const container = setup('<div class="happy-message" id="m1"><p>hi</p></div>')
        expect(resolveQuotableSelection(null, container)).toBeNull()
    })

    it('returns null for a collapsed selection', () => {
        const container = setup('<div class="happy-message" id="m1"><p>hi</p></div>')
        const sel = window.getSelection()!
        sel.removeAllRanges()
        expect(resolveQuotableSelection(sel, container)).toBeNull()
    })

    it('resolves text and messageId inside a message', () => {
        const container = setup('<div class="happy-message" id="m1"><p>hello world</p></div>')
        const sel = selectContents(container.querySelector('p')!)
        const result = resolveQuotableSelection(sel, container)
        expect(result?.text).toBe('hello world')
        expect(result?.messageId).toBe('m1')
    })

    it('returns null when the selection is outside any message', () => {
        const container = setup('<p id="loose">not a message</p>')
        const sel = selectContents(container.querySelector('#loose')!)
        expect(resolveQuotableSelection(sel, container)).toBeNull()
    })

    it('returns null for a whitespace-only selection', () => {
        const container = setup('<div class="happy-message" id="m1"><p>   </p></div>')
        const sel = selectContents(container.querySelector('p')!)
        expect(resolveQuotableSelection(sel, container)).toBeNull()
    })

    it('trims surrounding whitespace from the quoted text', () => {
        const container = setup('<div class="happy-message" id="m1"><p>  padded  </p></div>')
        const sel = selectContents(container.querySelector('p')!)
        expect(resolveQuotableSelection(sel, container)?.text).toBe('padded')
    })

    it('attributes a cross-message selection to the message it starts in', () => {
        const container = setup(
            '<div class="happy-message" id="m1"><p>first</p></div>'
            + '<div class="happy-message" id="m2"><p>second</p></div>'
        )
        const range = document.createRange()
        range.setStart(container.querySelector('#m1 p')!.firstChild!, 0)
        range.setEnd(container.querySelector('#m2 p')!.firstChild!, 6)
        const sel = window.getSelection()!
        sel.removeAllRanges()
        sel.addRange(range)
        expect(resolveQuotableSelection(sel, container)?.messageId).toBe('m1')
    })

    it('returns null when the selection lives outside the container', () => {
        const container = setup('<div class="happy-message" id="m1"><p>inside</p></div>')
        const outside = document.createElement('div')
        outside.className = 'happy-message'
        outside.id = 'm9'
        outside.innerHTML = '<p>outside</p>'
        document.body.appendChild(outside)
        const sel = selectContents(outside.querySelector('p')!)
        expect(resolveQuotableSelection(sel, container)).toBeNull()
    })
})
