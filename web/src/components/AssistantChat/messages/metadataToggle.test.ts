import { describe, expect, it } from 'vitest'
import type { KeyboardEvent, MouseEvent } from 'react'
import { isNestedInteractiveEvent } from './metadataToggle'

function makeMouseEvent(target: HTMLElement, currentTarget?: HTMLElement): MouseEvent<HTMLElement> {
    return { target, currentTarget } as unknown as MouseEvent<HTMLElement>
}

function makeKeyboardEvent(target: HTMLElement, currentTarget?: HTMLElement): KeyboardEvent<HTMLElement> {
    return { target, currentTarget } as unknown as KeyboardEvent<HTMLElement>
}

describe('isNestedInteractiveEvent', () => {
    it('returns true when the click target is itself a button', () => {
        const button = document.createElement('button')
        expect(isNestedInteractiveEvent(makeMouseEvent(button))).toBe(true)
    })

    it('returns true when the click target is nested inside a button (e.g. icon)', () => {
        const button = document.createElement('button')
        const icon = document.createElement('span')
        button.appendChild(icon)
        expect(isNestedInteractiveEvent(makeMouseEvent(icon))).toBe(true)
    })

    it('returns true for role="button" elements (Radix triggers, Markdown copy button)', () => {
        const div = document.createElement('div')
        div.setAttribute('role', 'button')
        const inner = document.createElement('span')
        div.appendChild(inner)
        expect(isNestedInteractiveEvent(makeMouseEvent(inner))).toBe(true)
    })

    it('returns true for anchors and form controls', () => {
        const a = document.createElement('a')
        const input = document.createElement('input')
        const textarea = document.createElement('textarea')
        const select = document.createElement('select')
        expect(isNestedInteractiveEvent(makeMouseEvent(a))).toBe(true)
        expect(isNestedInteractiveEvent(makeMouseEvent(input))).toBe(true)
        expect(isNestedInteractiveEvent(makeMouseEvent(textarea))).toBe(true)
        expect(isNestedInteractiveEvent(makeMouseEvent(select))).toBe(true)
    })

    it('returns false for plain message body text', () => {
        const root = document.createElement('div')
        const paragraph = document.createElement('p')
        paragraph.textContent = 'Hello'
        root.appendChild(paragraph)
        expect(isNestedInteractiveEvent(makeMouseEvent(paragraph))).toBe(false)
    })

    it('returns false when target is not an Element', () => {
        expect(isNestedInteractiveEvent({ target: null } as unknown as MouseEvent<HTMLElement>)).toBe(false)
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
        expect(isNestedInteractiveEvent(makeMouseEvent(svg as unknown as HTMLElement))).toBe(true)
        expect(isNestedInteractiveEvent(makeMouseEvent(path as unknown as HTMLElement))).toBe(true)
    })

    it('returns true when the click target is a native <summary> (tool-card details disclosure)', () => {
        // Tool cards expand their bodies via native <details><summary>; a
        // click on the summary must not flip the message metadata footer
        // alongside expanding the disclosure.
        const details = document.createElement('details')
        const summary = document.createElement('summary')
        summary.textContent = 'Task details'
        details.appendChild(summary)
        expect(isNestedInteractiveEvent(makeMouseEvent(summary))).toBe(true)
    })

    it('returns true when the click target is a status indicator (role="status")', () => {
        // MessageStatusIndicator renders queued/sending icons inside a span
        // with role="status"; clicks on those should not toggle metadata.
        const statusSpan = document.createElement('span')
        statusSpan.setAttribute('role', 'status')
        const inner = document.createElement('span')
        statusSpan.appendChild(inner)
        expect(isNestedInteractiveEvent(makeMouseEvent(statusSpan))).toBe(true)
        expect(isNestedInteractiveEvent(makeMouseEvent(inner))).toBe(true)
    })

    it('returns false when the only matching ancestor is the toggle wrapper itself', () => {
        // Regression: AssistantMessage / UserMessage assign role="button" to the
        // toggle wrapper for keyboard a11y. Without currentTarget exclusion,
        // closest('[role="button"]') from any inner click matches the wrapper
        // and the toggle bails out — the entire mouse-toggle path becomes dead.
        const wrapper = document.createElement('div')
        wrapper.setAttribute('role', 'button')
        const text = document.createElement('span')
        text.textContent = 'message body'
        wrapper.appendChild(text)
        expect(isNestedInteractiveEvent(makeMouseEvent(text, wrapper))).toBe(false)
    })

    it('still returns true when a real nested control sits between target and wrapper', () => {
        // The wrapper-exclusion guard must not let descendants slip through
        // — an actual button inside the wrapper still suppresses the toggle.
        const wrapper = document.createElement('div')
        wrapper.setAttribute('role', 'button')
        const innerButton = document.createElement('button')
        const icon = document.createElement('span')
        innerButton.appendChild(icon)
        wrapper.appendChild(innerButton)
        expect(isNestedInteractiveEvent(makeMouseEvent(icon, wrapper))).toBe(true)
    })

    it('returns true for Enter/Space keyboard events bubbling from a nested button', () => {
        // Keyboard parity with mouse path: pressing Enter on a focused
        // descendant button (e.g. Markdown code-copy) bubbles a keydown to the
        // wrapper. Without this guard the wrapper's onKeyDown would also flip
        // the metadata footer alongside the descendant's own activation.
        const wrapper = document.createElement('div')
        wrapper.setAttribute('role', 'button')
        const innerButton = document.createElement('button')
        wrapper.appendChild(innerButton)
        expect(isNestedInteractiveEvent(makeKeyboardEvent(innerButton, wrapper))).toBe(true)
    })

    it('returns false for keyboard events targeting the wrapper itself', () => {
        // Wrapper-exclusion must apply to keyboard too — a keydown targeting
        // the wrapper should still fire the toggle, otherwise keyboard users
        // lose the ability to open metadata via the wrapper.
        const wrapper = document.createElement('div')
        wrapper.setAttribute('role', 'button')
        expect(isNestedInteractiveEvent(makeKeyboardEvent(wrapper, wrapper))).toBe(false)
    })
})
