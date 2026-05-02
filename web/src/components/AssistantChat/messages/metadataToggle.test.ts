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

    it('returns false when target is not an HTMLElement', () => {
        expect(isClickOnNestedControl({ target: null } as unknown as MouseEvent<HTMLElement>)).toBe(false)
    })
})
