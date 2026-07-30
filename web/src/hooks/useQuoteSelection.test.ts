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

    it('returns null when the selection starts in a message but ends outside the container', () => {
        // 真人从消息里起拖、在 composer 或页面空白处松手时会走到这里。
        // 只校验命中的消息节点无法拦住它——起点确实在消息内——但选中的文本
        // 已经包含界面上的无关文字，会被原样序列化进发给 agent 的 prompt。
        const container = setup('<div class="happy-message" id="m1"><p>inside text</p></div>')
        const outside = document.createElement('p')
        outside.id = 'chrome'
        outside.textContent = 'composer chrome'
        document.body.appendChild(outside)

        const range = document.createRange()
        range.setStart(container.querySelector('#m1 p')!.firstChild!, 0)
        range.setEnd(outside.firstChild!, 8)
        const sel = window.getSelection()!
        sel.removeAllRanges()
        sel.addRange(range)

        expect(resolveQuotableSelection(sel, container)).toBeNull()
    })

    // 反向越界目前是被"找不到消息节点"那条挡住的，不是被 startContainer
    // 检查挡住的——撤掉边界检查这条依然通过。留着是为了在将来有人改动消息
    // 查找逻辑时，锁住"起点在容器外一律拒绝"这个行为。
    it('returns null when the selection ends in a message but starts outside the container', () => {
        const container = setup('<div class="happy-message" id="m1"><p>inside text</p></div>')
        const outside = document.createElement('p')
        outside.id = 'chrome'
        outside.textContent = 'page header'
        document.body.insertBefore(outside, document.getElementById('thread'))

        const range = document.createRange()
        range.setStart(outside.firstChild!, 0)
        range.setEnd(container.querySelector('#m1 p')!.firstChild!, 6)
        const sel = window.getSelection()!
        sel.removeAllRanges()
        sel.addRange(range)

        expect(resolveQuotableSelection(sel, container)).toBeNull()
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
