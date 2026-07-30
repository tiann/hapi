import { expect, test } from '@playwright/test'

// Regression: loading an older page prepends hundreds of messages at once.
// assistant-ui's tap scheduler aborts a flush with more than 50 dirty
// resources and drops the rest, so the thread never reflected the merged
// page (see patches/@assistant-ui%2Ftap@0.3.5.patch). This spec drives the
// real message-window store + HappyThread against a fake paginated API and
// pins the contract: one page per top approach, scroll position restored.
test('scroll-to-top loads one page per approach with correct scroll restore', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    // Wait for the initial tail sync plus the initial scroll-settling window.
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(2000)

    const afterFirst = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return {
            scrollTop: Math.round(el.scrollTop),
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
            beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
        }
    })

    // Exactly one page loaded, the DOM shows it, scroll restored away from top.
    expect(afterFirst.beforeReqs).toBe(1)
    expect(afterFirst.childCount).toBe(400)
    expect(afterFirst.scrollTop).toBeGreaterThan(1000)

    // Idle watch: no further loads may happen without another scroll.
    await page.waitForTimeout(2500)
    const idleReqs = await page.evaluate(() => window.__probe.requests.filter((r) => r.direction === 'before').length)
    expect(idleReqs).toBe(1)

    // Second approach to the top loads exactly one more page.
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(2000)
    const afterSecond = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return {
            scrollTop: Math.round(el.scrollTop),
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
            beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
        }
    })
    expect(afterSecond.beforeReqs).toBe(2)
    expect(afterSecond.childCount).toBe(600)
    expect(afterSecond.scrollTop).toBeGreaterThan(1000)
})
