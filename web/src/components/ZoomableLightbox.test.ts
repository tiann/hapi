import { describe, expect, it } from 'vitest'
import { measureContentSize, measureSvgIntrinsicSize } from './ZoomableLightbox'

type Rect = { width: number; height: number }

function makeSvg(opts: {
    viewBox?: { width: number; height: number }
    widthAttr?: string | null
    heightAttr?: string | null
    rect?: Rect | null
}): SVGSVGElement {
    const svg = {
        viewBox: opts.viewBox
            ? { baseVal: { width: opts.viewBox.width, height: opts.viewBox.height } }
            : { baseVal: { width: 0, height: 0 } },
        getAttribute(name: string) {
            if (name === 'width') return opts.widthAttr ?? null
            if (name === 'height') return opts.heightAttr ?? null
            return null
        },
        getBoundingClientRect() {
            return opts.rect ?? { width: 0, height: 0 }
        },
    }
    return svg as unknown as SVGSVGElement
}

function makeContent(opts: {
    img?: { naturalWidth: number; naturalHeight: number; rect?: Rect } | null
    svg?: SVGSVGElement | null
    rect?: Rect | null
}): HTMLElement {
    const queryResults = new Map<string, unknown>()
    if (opts.img) {
        queryResults.set('img', {
            naturalWidth: opts.img.naturalWidth,
            naturalHeight: opts.img.naturalHeight,
            getBoundingClientRect: () => opts.img?.rect ?? { width: 0, height: 0 },
        })
    }
    if (opts.svg) queryResults.set('svg', opts.svg)
    const content = {
        querySelector(selector: string) {
            return queryResults.get(selector) ?? null
        },
        getBoundingClientRect() {
            return opts.rect ?? { width: 0, height: 0 }
        },
    }
    return content as unknown as HTMLElement
}

describe('measureSvgIntrinsicSize', () => {
    it('prefers viewBox over the (possibly transformed) bounding rect', () => {
        const svg = makeSvg({
            viewBox: { width: 1200, height: 900 },
            rect: { width: 60, height: 45 },
        })
        expect(measureSvgIntrinsicSize(svg, 0.05)).toEqual({ width: 1200, height: 900 })
    })

    it('falls back to width/height attributes when viewBox is missing', () => {
        const svg = makeSvg({ widthAttr: '640', heightAttr: '480' })
        expect(measureSvgIntrinsicSize(svg)).toEqual({ width: 640, height: 480 })
    })

    it('divides bounding rect by the current scale to undo wrapper transform', () => {
        const svg = makeSvg({ rect: { width: 200, height: 100 } })
        expect(measureSvgIntrinsicSize(svg, 0.5)).toEqual({ width: 400, height: 200 })
    })

    it('returns null when no source is usable', () => {
        const svg = makeSvg({})
        expect(measureSvgIntrinsicSize(svg)).toBeNull()
    })
})

describe('measureContentSize', () => {
    it('prefers img.naturalSize over its bounding rect', () => {
        const content = makeContent({
            img: { naturalWidth: 800, naturalHeight: 600, rect: { width: 80, height: 60 } },
        })
        expect(measureContentSize(content, 0.1)).toEqual({ width: 800, height: 600 })
    })

    it('uses svg intrinsic size when no img is present', () => {
        const svg = makeSvg({ viewBox: { width: 500, height: 250 } })
        const content = makeContent({ svg })
        expect(measureContentSize(content, 0.5)).toEqual({ width: 500, height: 250 })
    })

    it('divides the host rect by current scale as the last fallback', () => {
        const content = makeContent({ rect: { width: 100, height: 50 } })
        expect(measureContentSize(content, 0.5)).toEqual({ width: 200, height: 100 })
    })

    it('treats non-positive scale as identity to avoid divide-by-zero', () => {
        const content = makeContent({ rect: { width: 100, height: 100 } })
        expect(measureContentSize(content, 0)).toEqual({ width: 100, height: 100 })
    })
})
