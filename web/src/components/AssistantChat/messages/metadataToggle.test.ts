import { describe, expect, it } from 'vitest'
import type { MouseEvent } from 'react'
import { isClickOnNestedControl } from './metadataToggle'

function makeMouseEvent(target: HTMLElement): MouseEvent<HTMLElement> {
    return { target } as unknown as MouseEvent<HTMLElement>
}

describe('isClickOnNestedControl', () => {
    it('returns true when the click target is itself a button', () => {
        const button = document.createElement('button')
        expect(isClickOnNestedControl(makeMouseEvent(button))).toBe(true)
    })

    it('returns true when the click target is nested inside a button (e.g. icon)', () => {
        const button = document.createElement('button')
        const icon = document.createElement('span')
        button.appendChild(icon)
        expect(isClickOnNestedControl(makeMouseEvent(icon))).toBe(true)
    })

    it('returns true for role="button" elements (Radix triggers, Markdown copy button)', () => {
        const div = document.createElement('div')
        div.setAttribute('role', 'button')
        const inner = document.createElement('span')
        div.appendChild(inner)
        expect(isClickOnNestedControl(makeMouseEvent(inner))).toBe(true)
    })

    it('returns true for anchors and form controls', () => {
        const a = document.createElement('a')
        const input = document.createElement('input')
        const textarea = document.createElement('textarea')
        const select = document.createElement('select')
        expect(isClickOnNestedControl(makeMouseEvent(a))).toBe(true)
        expect(isClickOnNestedControl(makeMouseEvent(input))).toBe(true)
        expect(isClickOnNestedControl(makeMouseEvent(textarea))).toBe(true)
        expect(isClickOnNestedControl(makeMouseEvent(select))).toBe(true)
    })

    it('returns false for plain message body text', () => {
        const root = document.createElement('div')
        const paragraph = document.createElement('p')
        paragraph.textContent = 'Hello'
        root.appendChild(paragraph)
        expect(isClickOnNestedControl(makeMouseEvent(paragraph))).toBe(false)
    })

    it('returns false when target is not an Element', () => {
        expect(isClickOnNestedControl({ target: null } as unknown as MouseEvent<HTMLElement>)).toBe(false)
    })

    it('returns true when the click target is an SVG icon inside a button', () => {
        // Icon-only controls (copy, retry, code-copy) render an <svg>/<path>
        // child of the <button>. Clicking the icon makes the event target an
        // SVGElement, which is not an HTMLElement — the guard must still walk
        // up to the enclosing button via closest().
        const button = document.createElement('button')
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        svg.appendChild(path)
        button.appendChild(svg)
        expect(isClickOnNestedControl(makeMouseEvent(svg as unknown as HTMLElement))).toBe(true)
        expect(isClickOnNestedControl(makeMouseEvent(path as unknown as HTMLElement))).toBe(true)
    })

    it('returns true when the click target is a native <summary> (tool-card details disclosure)', () => {
        // Tool cards expand their bodies via native <details><summary>; a
        // click on the summary must not flip the message metadata footer
        // alongside expanding the disclosure.
        const details = document.createElement('details')
        const summary = document.createElement('summary')
        summary.textContent = 'Task details'
        details.appendChild(summary)
        expect(isClickOnNestedControl(makeMouseEvent(summary))).toBe(true)
    })

    it('returns true when the click target is a status indicator (role="status")', () => {
        // MessageStatusIndicator renders queued/sending icons inside a span
        // with role="status"; clicks on those should not toggle metadata.
        const statusSpan = document.createElement('span')
        statusSpan.setAttribute('role', 'status')
        const inner = document.createElement('span')
        statusSpan.appendChild(inner)
        expect(isClickOnNestedControl(makeMouseEvent(statusSpan))).toBe(true)
        expect(isClickOnNestedControl(makeMouseEvent(inner))).toBe(true)
    })
})
