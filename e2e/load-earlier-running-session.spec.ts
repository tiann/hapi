import { expect, test } from '@playwright/test'

// Bug report: clicking "Load earlier" (outline button) on a RUNNING session
// (messages streaming in via SSE) made the chat viewport fly upward and keep
// jumping. Root cause: the tail-mode window trim evicted the freshly loaded
// older pages on the very next streaming ingest (and one more row per message
// afterwards), so the loaded range the user was reading vanished from the DOM
// and the viewport jumped up repeatedly.
//
// Regression: the loaded older range must survive streaming ingests while the
// user browses it. Driven against the real message-window store + HappyThread
// with a streaming fixture (`?outline=1` + probe.startStreaming).

test('running session: outline load-earlier keeps the loaded range and the viewport stable', async ({ page }) => {
    test.setTimeout(90_000)
    await page.goto('/e2e-fixtures/history-load-fixture.html?outline=1')
    const viewport = page.locator('.chat-scroll-y')
    await expect(viewport).toBeVisible()
    // Initial tail sync + initial scroll-settling window.
    await page.waitForTimeout(3500)

    // Click "Load earlier" in the outline (DOM click: Playwright's
    // actionability retries cannot keep up with dev-mode re-render churn).
    await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button'))
            .find((b) => b.getAttribute('aria-label') === 'Load earlier') as HTMLButtonElement | undefined
        if (!button) throw new Error('Load earlier button not found')
        button.click()
    })

    // Wait for the older page request, then for it to apply.
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    ), { timeout: 10_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(async () => await page.evaluate(() =>
        document.querySelector('.happy-thread-messages')?.childElementCount ?? 0
    ), { timeout: 10_000 }).toBeGreaterThanOrEqual(400)

    // Now the session starts running: messages stream in continuously.
    await page.evaluate(() => window.__probe.startStreaming(800))

    // Sample the scroll position and window contents while streaming continues.
    let flewUp = false
    let loadedRangeEvicted = false
    for (let i = 0; i < 3; i += 1) {
        await page.waitForTimeout(400)
        const sample = await page.evaluate(() => {
            const el = document.querySelector('.chat-scroll-y') as HTMLElement
            const firstMessage = document.querySelector('.happy-thread-messages > [id]')
            const firstSeq = firstMessage
                ? Number(firstMessage.id.match(/m-(\d+)/)?.[1] ?? 0)
                : 0
            return {
                scrollTop: Math.round(el.scrollTop),
                max: el.scrollHeight - el.clientHeight,
                childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
                firstSeq
            }
        })
        // The viewport must never fly to the top while the tail streams.
        if (sample.max > 0 && sample.scrollTop < sample.max * 0.3) {
            flewUp = true
        }
        // The loaded older range (m-801, the oldest loaded page) must remain
        // rendered instead of being evicted by the streaming ingests.
        if (sample.firstSeq !== 801) {
            loadedRangeEvicted = true
        }
    }

    const final = await page.evaluate(() => ({
        streamed: window.__probe.streamedCount(),
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length,
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        firstSeq: Number(document.querySelector('.happy-thread-messages > [id]')?.id.match(/m-(\d+)/)?.[1] ?? 0)
    }))

    console.log('final:', JSON.stringify(final), 'flewUp:', flewUp, 'loadedRangeEvicted:', loadedRangeEvicted)

    expect(final.beforeReqs).toBeGreaterThanOrEqual(1)
    // The loaded older page was applied and survived the streaming ingests.
    expect(final.childCount).toBeGreaterThanOrEqual(400)
    expect(final.firstSeq).toBe(801)
    // The viewport never flew to the top.
    expect(flewUp).toBe(false)
    expect(loadedRangeEvicted).toBe(false)
})
