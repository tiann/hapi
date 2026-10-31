import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Reading forward past the window limit trims rows off the old end. Message
 * CSS disables browser scroll anchoring, so without capturing an anchor before
 * the page is applied and restoring it afterwards, the unchanged scrollTop
 * lands roughly a page later and jumps past the newly loaded messages
 * (tiann/hapi#1598 review).
 *
 * The behaviour itself needs a browser to assert end to end; this guards the
 * wiring so the anchor cannot be dropped from the forward path unnoticed.
 */
describe('forward history load scroll anchoring', () => {
    const source = readFileSync(resolve(__dirname, 'HappyThread.tsx'), 'utf8')

    it('captures a scroll anchor before requesting a newer page', () => {
        const trigger = source.slice(
            source.indexOf('requestForwardPageRef.current = () => {'),
            source.indexOf('.finally(() => { loadingNewerRef.current = false })')
        )

        expect(trigger).toContain('captureScrollAnchor')
        expect(trigger).toContain('pendingForwardAnchorRef.current =')
        // The protected row must be resolved when the page lands, not now.
        expect(trigger).toContain('() => anchorMessageIdFromAnchor(pendingForwardAnchorRef.current)')
    })

    it('also requests a page when the context renders shorter than the viewport', () => {
        // No scroll event ever fires in that case, so the scroll handler alone
        // would strand the reader.
        const effect = source.slice(
            source.indexOf('if (props.hasMoreNewerMessages !== true) return'),
            source.indexOf('}, [props.hasMoreNewerMessages,')
        )

        expect(effect).toContain('scrollHeight - viewport.clientHeight')
        expect(effect).toContain('requestForwardPageRef.current()')
    })

    it('refreshes the pending anchor while the user scrolls during a load', () => {
        const scrollHandler = source.slice(
            source.indexOf('const pending = pendingScrollRef.current'),
            source.indexOf('const needsCoverage = needsViewportCoverageRef.current()')
        )

        // Restoring the start-of-request anchor would drag a user who scrolled
        // away back to where they were.
        expect(scrollHandler).toContain('pendingForwardAnchorRef.current = captureScrollAnchor(viewport)')
    })

    it('restores that anchor once the loaded history version renders', () => {
        const restoreEffect = source.slice(
            source.indexOf('const forwardAnchor = pendingForwardAnchorRef.current'),
            source.indexOf('}, [appliedHistoryVersion])')
        )

        expect(restoreEffect).toContain('restoreScrollAnchor')
        // Clearing it matters: a stale anchor would fight the next scroll.
        expect(restoreEffect).toContain('pendingForwardAnchorRef.current = null')
    })
})
