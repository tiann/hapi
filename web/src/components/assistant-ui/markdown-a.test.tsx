/**
 * Tests for the custom <A> anchor component and the inlined URL policy helpers
 * in markdown-text.tsx.
 *
 * Covers:
 *   - classifyScheme: IANA / deny / custom, 6-axis security bypass
 *   - denyOnlyTransform: deny → "", IANA/custom → pass-through, relative paths
 *   - useAllowedSchemes (inlined): localStorage roundtrip, cross-tab storage event, tamper guard
 *   - <A> component click behaviour: deny, IANA, custom (dialog opened via context)
 *   - intra-tab cross-provider sync via module-level schemeListeners emitter
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react'
import React from 'react'
import { defaultComponents, classifyScheme, denyOnlyTransform, UriConfirmProvider } from '@/components/assistant-ui/markdown-text'
import { I18nProvider } from '@/lib/i18n-context'

// defaultComponents.a is the memoized A component.
const AnchorComponent = (defaultComponents as Record<string, unknown>).a as React.ComponentType<
    React.ComponentPropsWithoutRef<'a'>
>

// Helper: wrap A in UriConfirmProvider so useContext(UriConfirmContext) is non-null.
// Previously <A> had a localHook fallback for bare renders, but that fallback
// added a storage listener per link (N links → N+1 listeners). The fallback is
// removed; tests must provide the context instead.
function renderA(props: React.ComponentPropsWithoutRef<'a'>) {
    return render(
        <I18nProvider>
            <UriConfirmProvider>
                <AnchorComponent {...props} />
            </UriConfirmProvider>
        </I18nProvider>
    )
}

const STORAGE_KEY = 'hapi-allowed-schemes'

beforeEach(() => {
    localStorage.clear()
    cleanup()
    vi.clearAllMocks()
})

// ── classifyScheme ────────────────────────────────────────────────────────────

describe('classifyScheme — IANA schemes', () => {
    it.each(['https://example.com', 'http://example.com', 'mailto:user@x.com', 'irc://irc.libera.chat', 'ircs://irc.libera.chat', 'xmpp:user@x.com'])(
        'classifies %s as iana',
        (url) => expect(classifyScheme(url)).toBe('iana')
    )
    it('classifies HTTPS: (uppercase) as iana (case-insensitive)', () => {
        expect(classifyScheme('HTTPS://example.com')).toBe('iana')
    })
})

describe('classifyScheme — deny schemes', () => {
    it.each(['javascript:alert(1)', 'data:text/html,<h1>xss</h1>', 'vbscript:msgbox(1)', 'file:///tmp/test.txt'])(
        'classifies %s as deny',
        (url) => expect(classifyScheme(url)).toBe('deny')
    )
})

describe('classifyScheme — custom schemes', () => {
    it.each(['obsidian://open?vault=V&file=F', 'vscode://file/path', 'slack://channel?team=T123'])(
        'classifies %s as custom',
        (url) => expect(classifyScheme(url)).toBe('custom')
    )
})

describe('classifyScheme — security bypass axes', () => {
    // (a) case bypass
    it.each(['JavaScript:alert(1)', 'JAVASCRIPT:alert(1)'])('blocks %s (case) as deny', (url) =>
        expect(classifyScheme(url)).toBe('deny')
    )
    // (b) whitespace prefix on entire URL
    it.each(['\tjavascript:alert(1)', '\njavascript:alert(1)', ' javascript:alert(1)'])('blocks %s (whitespace prefix) as deny', (url) =>
        expect(classifyScheme(url)).toBe('deny')
    )
    // (c) percent-encoding
    it('%6Aavascript: (encoded j) → deny', () => expect(classifyScheme('%6Aavascript:alert(1)')).toBe('deny'))
    it('jav%61script: (encoded a) → deny', () => expect(classifyScheme('jav%61script:alert(1)')).toBe('deny'))
    // (d) double-encoding — 2-pass decode unwraps javascript%253A → javascript%3A → javascript:
    // With 2-pass decode, the second pass resolves %3A → literal colon, so the scheme
    // "javascript" is extracted and hits DENY_SCHEMES → 'deny' via scheme-match.
    it('javascript%253A (double-encoded colon) → deny', () => expect(classifyScheme('javascript%253Aalert(1)')).toBe('deny'))
    // `javascript%3Aalert(1)` — single-encoded colon. decodeURIComponent yields
    // `javascript:alert(1)` with a literal colon, so classifyScheme extracts scheme
    // "javascript" → hits DENY_SCHEMES → 'deny'. This is the real scheme-match path.
    it('javascript%3A (single-encoded colon) → deny via scheme-match', () => expect(classifyScheme('javascript%3Aalert(1)')).toBe('deny'))
    // (e) control characters spliced into scheme name
    // Browsers strip \n, \t, \r from URL schemes during navigation; our normalizer
    // must do the same before comparing against the deny list.
    it('java\\nscript: (newline in scheme) → deny', () => expect(classifyScheme('java\nscript:alert(1)')).toBe('deny'))
    it('java\\tscript: (tab in scheme) → deny', () => expect(classifyScheme('java\tscript:alert(1)')).toBe('deny'))
    it('java\\rscript: (carriage return in scheme) → deny', () => expect(classifyScheme('java\rscript:alert(1)')).toBe('deny'))
    it('java script: (space in scheme) → deny', () => expect(classifyScheme('java script:alert(1)')).toBe('deny'))
    // percent-encoded control chars inside the scheme — decoded by pass 1 then stripped
    it('java%0Ascript: (percent-encoded newline in scheme) → deny', () => expect(classifyScheme('java%0Ascript:alert(1)')).toBe('deny'))
    // leading whitespace on the URL itself (already covered by trimStart, added for completeness)
    it('\\tjavascript: (leading tab on URL) → deny', () => expect(classifyScheme('\tjavascript:alert(1)')).toBe('deny'))
    // case sanity (also covered above but keep explicit)
    it('JAVASCRIPT: → deny', () => expect(classifyScheme('JAVASCRIPT:alert(1)')).toBe('deny'))
    it('JaVaScRipT: → deny', () => expect(classifyScheme('JaVaScRipT:')).toBe('deny'))
    // edge
    it('empty string → deny', () => expect(classifyScheme('')).toBe('deny'))
    it('no-colon string → deny', () => expect(classifyScheme('not-a-url')).toBe('deny'))
})

// ── denyOnlyTransform ─────────────────────────────────────────────────────────

describe('denyOnlyTransform', () => {
    it.each(['javascript:alert(1)', 'data:text/html,xss', 'vbscript:x', 'file:///tmp/f', 'JavaScript:alert(1)', 'jav%61script:alert(1)', '%6Aavascript:alert(1)'])(
        'strips %s → ""',
        (url) => expect(denyOnlyTransform(url)).toBe('')
    )
    it.each(['https://example.com', 'http://example.com', 'mailto:a@b.com'])(
        'passes %s through unchanged',
        (url) => expect(denyOnlyTransform(url)).toBe(url)
    )
    it.each(['obsidian://open?vault=V', 'vscode://file/path', 'slack://channel'])(
        'passes custom scheme %s through unchanged',
        (url) => expect(denyOnlyTransform(url)).toBe(url)
    )
    it('passes relative path through', () => {
        expect(denyOnlyTransform('/relative/path')).toBe('/relative/path')
    })
})

// ── useAllowedSchemes (inlined hook, tested via A component) ──────────────────

describe('localStorage roundtrip via A component', () => {
    it('renders href="#" for unallowed custom scheme', () => {
        renderA({ href: 'obsidian://open?vault=V&file=F', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('#')
    })

    it('renders real href for pre-seeded allowed custom scheme', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['obsidian']))
        renderA({ href: 'obsidian://open?vault=V&file=F', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('obsidian://open?vault=V&file=F')
    })

    it('isAllowed returns false for deny scheme even if tampered into localStorage', () => {
        // Tamper: put javascript into allowed list
        localStorage.setItem(STORAGE_KEY, JSON.stringify(['javascript']))
        // The A component should still not treat javascript as allowed (it classifies to 'deny')
        renderA({ href: 'javascript:alert(1)', children: 'evil' })
        // href="" comes from denyOnlyTransform; onclick should preventDefault
        const link = document.querySelector('a')!
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        link.dispatchEvent(clickEvent)
        expect(preventSpy).toHaveBeenCalled()
    })
})

describe('cross-tab sync via storage event', () => {
    it('updates after storage event fires (simulated other-tab write)', () => {
        // Start with empty storage, render an unallowed custom link
        renderA({ href: 'obsidian://open', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('#')

        // Simulate another tab writing the allowed schemes
        act(() => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(['obsidian']))
            window.dispatchEvent(new StorageEvent('storage', {
                key: STORAGE_KEY,
                newValue: JSON.stringify(['obsidian']),
                storageArea: localStorage,
            }))
        })

        // After storage event the hook re-reads; re-render the component
        cleanup()
        renderA({ href: 'obsidian://open', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('obsidian://open')
    })
})

// ── <A> component — click handler ────────────────────────────────────────────

describe('markdown <A> component — click handler', () => {
    it('prevents default when href is empty string (deny-scheme link)', () => {
        renderA({ href: '', children: 'deny' })
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        document.querySelector('a')!.dispatchEvent(clickEvent)
        expect(preventSpy).toHaveBeenCalled()
    })

    it('prevents default when href is undefined', () => {
        renderA({ children: 'no href' })
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        document.querySelector('a')!.dispatchEvent(clickEvent)
        expect(preventSpy).toHaveBeenCalled()
    })

    it('renders href="#" for an unallowed custom scheme (no middle-click bypass)', () => {
        renderA({ href: 'obsidian://open?vault=V&file=F', children: 'note' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('#')
    })

    it('renders the real href for an IANA scheme (https)', () => {
        renderA({ href: 'https://example.com', children: 'link' })
        expect(document.querySelector('a')!.getAttribute('href')).toBe('https://example.com')
    })

    it('does not navigate for a deny scheme (href="")', () => {
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
        renderA({ href: '', children: 'evil' })
        fireEvent.click(document.querySelector('a')!)
        expect(openSpy).not.toHaveBeenCalled()
        openSpy.mockRestore()
    })
})

// ── relative / no-scheme hrefs — regression guard ────────────────────────────
//
// Finding 2: denyOnlyTransform passes relative hrefs through unchanged (no colon
// → not a scheme URL), but the <A> onClick handler called classifyScheme(href)
// which returned 'deny' for inputs with no valid scheme → preventDefault was
// called → relative/internal links were silently blocked.
//
// Fix: <A> must detect hrefs that have no scheme and treat them as 'iana' so the
// browser/router can navigate normally.

describe('markdown <A> component — relative / no-scheme hrefs navigate normally', () => {
    // Each of these hrefs has no URL scheme. Clicks must NOT be prevented.
    // We verify by checking that preventDefault is NOT called on the click event.

    function clickAndCheckNotPrevented(href: string) {
        renderA({ href, children: 'link' })
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventSpy = vi.spyOn(clickEvent, 'preventDefault')
        document.querySelector('a')!.dispatchEvent(clickEvent)
        expect(preventSpy).not.toHaveBeenCalled()
        cleanup()
    }

    it('/settings → click not prevented (absolute-path relative link)', () => {
        clickAndCheckNotPrevented('/settings')
    })

    it('./foo → click not prevented (relative-path link)', () => {
        clickAndCheckNotPrevented('./foo')
    })

    it('#section → click not prevented (hash fragment link)', () => {
        clickAndCheckNotPrevented('#section')
    })

    it('?q=1 → click not prevented (query-only link)', () => {
        clickAndCheckNotPrevented('?q=1')
    })

    it('/path:colon → click not prevented (path with colon, no scheme)', () => {
        // "/" appears before ":" so this is a path, not a scheme.
        clickAndCheckNotPrevented('/path:colon')
    })

    it('//example.com → click not prevented (protocol-relative URL, no colon)', () => {
        // Protocol-relative URLs have no colon; browsers navigate them as the
        // current origin's protocol, same as any other relative href.
        clickAndCheckNotPrevented('//example.com/path')
    })

    it('https://example.com → click not prevented (regression: IANA still passes through)', () => {
        clickAndCheckNotPrevented('https://example.com')
    })
})

// ── intra-tab cross-provider sync (schemeListeners emitter) ──────────────────
//
// P7e.1 added a module-level `schemeListeners: Set<SchemeListener>` so that
// when two sibling <UriConfirmProvider>s exist in the same window (e.g.
// MarkdownText + Reasoning in AssistantMessage), clicking "Always allow" in
// one provider's dialog immediately updates the other without waiting for a
// cross-tab storage event (which browsers only fire in OTHER tabs).
//
// This test asserts that path: mount two sibling providers, trigger allow()
// in one via the dialog flow, verify the other's link href updates.

describe('intra-tab cross-provider sync (schemeListeners emitter)', () => {
    it('allowing a scheme in one UriConfirmProvider propagates to a sibling provider', async () => {
        localStorage.clear()

        // Suppress window.open — handleAlwaysAllow calls it after allow()
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

        render(
            <I18nProvider>
                <UriConfirmProvider>
                    <AnchorComponent href="obsidian://open?a=1">link1</AnchorComponent>
                </UriConfirmProvider>
                <UriConfirmProvider>
                    <AnchorComponent href="obsidian://open?a=2">link2</AnchorComponent>
                </UriConfirmProvider>
            </I18nProvider>
        )

        const links = screen.getAllByRole('link')
        const [a1, a2] = links

        // Both links start blocked (href="#") because obsidian is not yet allowed.
        expect(a1.getAttribute('href')).toBe('#')
        expect(a2.getAttribute('href')).toBe('#')

        // Click the first link → its provider opens the UriConfirmDialog.
        await act(async () => {
            fireEvent.click(a1)
        })

        // The "Always allow obsidian:" button is rendered by UriConfirmDialog
        // via Radix Dialog portal into document.body.
        const alwaysBtn = await waitFor(() =>
            screen.getByRole('button', { name: /always allow obsidian/i })
        )

        await act(async () => {
            fireEvent.click(alwaysBtn)
        })

        // After "Always allow", the schemeListeners emitter must have notified
        // the sibling provider synchronously. Both links should now carry the
        // live href (not '#').
        await waitFor(() => {
            expect(a1.getAttribute('href')).toBe('obsidian://open?a=1')
            expect(a2.getAttribute('href')).toBe('obsidian://open?a=2')
        })

        openSpy.mockRestore()
    })
})
