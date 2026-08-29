import { expect, test } from '@playwright/test'

// Regression for issue #1587: clicking "jump to conversation start" on a long
// session must scroll the chat to the very top without the window store
// evicting the newest messages mid-load (which made the chat view "jump back"
// along the scroll animation and could leave the view stranded near the
// bottom). The composer shell / StatusBar live outside the chat scroll
// viewport and must not move, and the context-stats label must keep
// reflecting the session's live tail usage throughout.
test('jump to conversation start reaches the top without dragging the composer or stats', async ({ page }) => {
    // The 1200-message fixture is heavy; the dev server + render passes need room.
    test.setTimeout(240_000)
    await page.goto('/e2e-fixtures/jump-navigation-fixture.html')
    const shell = page.locator('[data-testid="composer-shell"]')
    await expect(shell).toBeVisible()
    // Wait for the initial tail sync plus the initial scroll-settling window.
    await page.waitForTimeout(3500)
    await expect.poll(async () => await page.evaluate(() => window.__jumpProbe.windowState().messageCount), {
        timeout: 30_000,
    }).toBe(200)

    // Tail usage event is in the window: status bar shows live context stats.
    const initialStatus = await page.evaluate(() => window.__jumpProbe.statusText())
    expect(initialStatus).not.toBeNull()
    expect(initialStatus).toMatch(/12k \/ 27k/i)

    const before = await page.evaluate(() => window.__jumpProbe.composerRect())
    expect(before).not.toBeNull()

    // Sample the composer shell and status label for the whole jump (load
    // phase included): the shell must not move and the label must not flicker.
    await page.evaluate(() => window.__jumpProbe.startSampling())

    // Hover the last assistant reply so its navigation actions appear, then
    // click its jump-to-conversation-start button. A DOM click avoids the
    // actionability dance over the 1200-message DOM on slow runners.
    const lastReply = page.locator('.happy-message', { hasText: 'Fixture assistant reply 600' }).last()
    await lastReply.hover()
    await page.evaluate(() => {
        const replies = [...document.querySelectorAll('.happy-message')]
        const reply = replies.find((el) => el.textContent?.includes('Fixture assistant reply 600'))
        const button = reply?.querySelector<HTMLButtonElement>('[title="Jump to conversation start"]')
        if (!button) throw new Error('jump-to-conversation-start button not found')
        button.click()
    })

    // Loading all older pages + the smooth scroll animation. Poll for the
    // landing so the assertions do not race the render passes. Sampling is
    // deferred until after the landing: every sample forces a layout flush,
    // which starves the render passes on slow runners.
    let landingState: { viewMode: string; messageCount: number; scrollTop: number; oldestSeq: number | null; newestSeq: number | null } | null = null
    const landingDeadline = Date.now() + 180_000
    while (Date.now() < landingDeadline) {
        landingState = await page.evaluate(() => window.__jumpProbe.windowState())
        if (landingState.scrollTop === 0) break
        await page.waitForTimeout(500)
    }
    if (!landingState || landingState.scrollTop !== 0) {
        const dump = await page.evaluate(() => ({
            state: window.__jumpProbe.windowState(),
            requests: window.__jumpProbe.requests,
            pill: document.querySelector('[role="status"]')?.textContent?.trim() ?? null
        }))
        console.log('JUMP LANDING DUMP:', JSON.stringify(dump))
    }
    expect(landingState?.scrollTop).toBe(0)
    await page.evaluate(() => window.__jumpProbe.stopSampling())

    const samples = await page.evaluate(() => window.__jumpProbe.composerSamples)
    expect(samples.length).toBeGreaterThan(5)

    // The composer shell is a sibling below the scroll viewport: its rect must
    // not move at any point during the whole jump (loading + animation).
    const topDelta = Math.max(...samples.map((s) => s.top)) - Math.min(...samples.map((s) => s.top))
    expect(topDelta).toBe(0)

    // The context-stats label must not flicker while the window loads: it
    // keeps describing the live tail usage throughout (the head-only window
    // drops the usage rows, so the label rides the last-known-usage snapshot).
    const statusSamples = await page.evaluate(() => window.__jumpProbe.statusSamples)
    expect(statusSamples.length).toBeGreaterThan(5)
    expect(statusSamples.every((value) => value === initialStatus)).toBe(true)

    // The navigation kept a bounded head + live-tail window with an explicit
    // gap marker between them (no mid-load eviction + tail reset): the
    // conversation start is in view, the tail usage rows survive, and the
    // marker keeps the retained tail from silently linking to head prompts…
    const finalState = await page.evaluate(() => window.__jumpProbe.windowState())
    expect(finalState.oldestSeq).toBe(1)
    expect(finalState.newestSeq).toBe(1201)
    expect(finalState.messageCount).toBe(1001)
    // The gap marker sits between the retained head and tail (off-screen
    // under virtualization, so assert on the store window).
    expect(finalState.gapPresent).toBe(true)

    // …and any tail refresh requested mid-navigation was queued, not fired
    // while the loads were in flight (at most the single post-landing refresh).
    const requests = await page.evaluate(() => window.__jumpProbe.requests)
    const afterCount = requests.filter((r) => r.direction === 'after').length
    expect(afterCount).toBeLessThanOrEqual(1)
    // The queued refresh found nothing newer, so the window was not replaced.
    expect(finalState.newestSeq).toBe(1201)
})
