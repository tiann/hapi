import { afterEach, describe, expect, it } from 'vitest'
import { getKaTeXFontRequests } from './ShareTurnDialog'

describe('getKaTeXFontRequests', () => {
    afterEach(() => {
        document.body.innerHTML = ''
    })

    it('returns only the KaTeX families and variants used by the formula', () => {
        const root = document.createElement('div')
        root.innerHTML = `
            <span class="katex">
                <span data-font="main"></span>
                <span data-font="math"></span>
                <span data-font="ams"></span>
                <span data-font="fallback"></span>
            </span>
        `
        document.body.appendChild(root)

        root.querySelector('[data-font="main"]')!.setAttribute('style', 'font-family: "KaTeX_Main", serif')
        root.querySelector('[data-font="math"]')!.setAttribute('style', 'font-family: "KaTeX_Math", serif; font-style: italic')
        root.querySelector('[data-font="ams"]')!.setAttribute('style', 'font-family: "KaTeX_AMS", serif; font-weight: 700')
        root.querySelector('[data-font="fallback"]')!.setAttribute('style', 'font-family: serif')

        expect(getKaTeXFontRequests(root)).toEqual([
            '16px "KaTeX_Main"',
            'italic 16px "KaTeX_Math"',
            'bold 16px "KaTeX_AMS"',
        ])
    })

    it('falls back to the main KaTeX font when computed styles are unavailable', () => {
        const root = document.createElement('div')
        root.innerHTML = '<span class="katex"><span style="font-family: serif"></span></span>'
        document.body.appendChild(root)

        expect(getKaTeXFontRequests(root)).toEqual(['16px "KaTeX_Main"'])
    })
})
