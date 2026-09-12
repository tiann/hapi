import { describe, expect, it } from 'vitest'

import { injectBaseTag, rewriteHtml, rewriteLocation, rewriteSetCookie, rewriteSrcset } from './rewrite'

describe('rewriteHtml', () => {
    it('rewrites root-relative src/href attributes with the prefix', () => {
        const html = '<html><head></head><body><img src="/a.png"><a href="/page">x</a></body></html>'
        const rewritten = rewriteHtml(html, '/preview/m1')
        expect(rewritten).toContain('src="/preview/m1/a.png"')
        expect(rewritten).toContain('href="/preview/m1/page"')
    })

    it('leaves external, protocol-relative, data and fragment URLs alone', () => {
        const html = '<img src="https://e.com/x.png"><img src="//cdn/y.png"><img src="data:image/png;base64,AA"><a href="#top">t</a>'
        const rewritten = rewriteHtml(html, '/preview/m1')
        expect(rewritten).toBe(html)
    })

    it('rewrites srcset candidates', () => {
        const html = '<img srcset="/a.png 1x, /b@2x.png 2x, https://e.com/c.png 3x">'
        const rewritten = rewriteHtml(html, '/preview/m1')
        expect(rewritten).toContain('/preview/m1/a.png 1x')
        expect(rewritten).toContain('/preview/m1/b@2x.png 2x')
        expect(rewritten).toContain('https://e.com/c.png 3x')
    })

    it('injects a base tag after <head> unless one exists', () => {
        const withHead = rewriteHtml('<html><head><title>t</title></head></html>', '/preview/m1')
        expect(withHead).toContain('<head><base href="/preview/m1/">')

        // An existing <base> is not duplicated — but its root-relative href is
        // still rewritten (a root-relative base would break the sub-path).
        const withBase = rewriteHtml('<html><head><base href="/x/"></head></html>', '/preview/m1')
        expect(withBase).toContain('href="/preview/m1/x/"')
        expect(withBase.match(/<base/g)).toHaveLength(1)
    })
})

describe('rewriteSrcset', () => {
    it('handles bare and descriptor forms', () => {
        expect(rewriteSrcset('/a.png', '/p')).toBe('/p/a.png')
        expect(rewriteSrcset('/a.png 2x, b.png 1x', '/p')).toBe('/p/a.png 2x, b.png 1x')
    })
})

describe('rewriteLocation', () => {
    it('prefixes root-relative locations only', () => {
        expect(rewriteLocation('/login', '/preview/m1')).toBe('/preview/m1/login')
        expect(rewriteLocation('http://127.0.0.1:5173/x', '/preview/m1')).toBe('http://127.0.0.1:5173/x')
        expect(rewriteLocation('next/page', '/preview/m1')).toBe('next/page')
    })
})

describe('rewriteSetCookie', () => {
    it('rewrites Path attributes to the prefix', () => {
        expect(rewriteSetCookie('sid=1; Path=/', '/preview/m1')).toBe('sid=1; Path=/preview/m1/')
        expect(rewriteSetCookie('sid=1; path=/app;', '/preview/m1')).toBe('sid=1; Path=/preview/m1/app;')
    })

    it('leaves cookies without a Path alone', () => {
        expect(rewriteSetCookie('sid=1; HttpOnly', '/preview/m1')).toBe('sid=1; HttpOnly')
    })
})

describe('injectBaseTag', () => {
    it('is a no-op without a head element', () => {
        expect(injectBaseTag('<div>x</div>', '/p/')).toBe('<div>x</div>')
    })
})
