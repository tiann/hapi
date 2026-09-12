import { expect, test } from '@playwright/test'

test('cold sessions request a small latest page and keep older loads at 200', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?coldInitial=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()

    await expect.poll(async () => await page.evaluate(() => window.__probe.requests.length)).toBeGreaterThan(0)
    await expect.poll(async () => await page.evaluate(() => ({
        direction: window.__probe.requests[0]?.direction ?? null,
        limit: window.__probe.requests[0]?.limit ?? null,
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0
    }))).toEqual({
        direction: 'latest',
        limit: 20,
        childCount: expect.any(Number)
    })

    await expect.poll(async () => await page.evaluate(() => window.__probe.windowState().messageCount)).toBe(20)
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()

    // Call the same loadMore callback that the top sentinel invokes. The
    // dedicated history-load suite covers pointer/scroll gesture detection;
    // this regression should isolate the page-size contract without relying
    // on IntersectionObserver timing.
    await page.evaluate(() => window.__probe.loadMore())

    await expect.poll(async () => await page.evaluate(() => {
        const older = window.__probe.requests.filter((request) => request.direction === 'before')
        return older[0]?.limit ?? null
    })).toBe(200)
})
