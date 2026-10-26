import { expect as baseExpect, test } from '@playwright/test'

// The capped-window cases render 800 real messages, including on small runners.
test.setTimeout(90_000)
const expect = baseExpect.configure({ timeout: 20_000 })

test('cached re-entry keeps the cache visible while refreshing a small latest tail', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?cachedReentry=1&holdLatest=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()

    await expect.poll(async () => await page.evaluate(() => ({
        latestRequests: window.__probe.requests.filter((request) => request.direction === 'latest').length,
        latestLimit: window.__probe.requests.find((request) => request.direction === 'latest')?.limit ?? null
    }))).toEqual({ latestRequests: 1, latestLimit: 20 })

    // The persisted snapshot must remain usable while the latest-tail request
    // is held in flight; this is the user-visible cache-first contract.
    await expect(page.getByText('Fixture message 1001', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.__probe.requests.filter((request) => request.direction === 'before').length)).toBe(0)

    await page.evaluate(() => window.__probe.releaseLatest())
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
    await expect(page.getByText('Fixture message 1001', { exact: true })).toHaveCount(0)

    // The small latest page still exposes its normal older cursor; scrolling
    // to the top must load one full history page through the existing path.
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await page.evaluate(() => {
        const element = document.querySelector('.app-scroll-y') as HTMLElement
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    await expect.poll(async () => await page.evaluate(() => ({
        beforeRequests: window.__probe.requests.filter((request) => request.direction === 'before').length,
        beforeLimit: window.__probe.requests.find((request) => request.direction === 'before')?.limit ?? null
    }))).toEqual({ beforeRequests: 1, beforeLimit: 200 })
    await expect(page.getByText('Fixture message 1001', { exact: true })).toBeVisible()
})

test('cached re-entry resumes an upward history gesture after latest refresh completes', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?cachedReentry=1&holdLatest=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await expect.poll(async () => await page.evaluate(() => ({
        latestRequests: window.__probe.requests.filter((request) => request.direction === 'latest').length,
        latestLimit: window.__probe.requests.find((request) => request.direction === 'latest')?.limit ?? null
    }))).toEqual({ latestRequests: 1, latestLimit: 20 })

    // The user starts browsing older history before the latest refresh returns.
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await page.evaluate(() => {
        const element = document.querySelector('.app-scroll-y') as HTMLElement
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    expect(await page.evaluate(() => window.__probe.requests.filter((request) => request.direction === 'before').length)).toBe(0)

    await page.evaluate(() => window.__probe.releaseLatest())
    await expect.poll(async () => await page.evaluate(() => ({
        beforeRequests: window.__probe.requests.filter((request) => request.direction === 'before').length,
        beforeLimit: window.__probe.requests.find((request) => request.direction === 'before')?.limit ?? null
    }))).toEqual({ beforeRequests: 1, beforeLimit: 200 })
    await expect(page.getByText('Fixture message 1000', { exact: true })).toBeVisible()
})

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

    // A fresh scrollbar-style approach to the top loads exactly one more page.
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await page.evaluate(() => {
        const element = document.querySelector('.app-scroll-y') as HTMLElement
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
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

// A user may adjust position inside the preload area before a slow request
// finishes. The prepend must preserve their latest offset, not snap back to
// the stale top anchor captured when the request started.
test('scrolling within the preload area rebases the pending anchor', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?slowBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)

    const latestAnchor = await page.evaluate(() => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        viewport.scrollTop = 100
        viewport.dispatchEvent(new Event('scroll'))
        const viewportRect = viewport.getBoundingClientRect()
        const message = Array.from(
            viewport.querySelectorAll<HTMLElement>('.happy-thread-messages > [id]')
        ).find((candidate) => {
            const rect = candidate.getBoundingClientRect()
            return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
        })
        if (!message) throw new Error('Expected a visible message anchor')
        return {
            id: message.id,
            topOffset: message.getBoundingClientRect().top - viewportRect.top
        }
    })

    await expect.poll(async () => await page.evaluate(() =>
        document.querySelector('.happy-thread-messages')?.childElementCount ?? 0
    )).toBe(400)

    const restoredOffset = await page.evaluate((anchorId) => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        const message = document.getElementById(anchorId)
        if (!message) throw new Error('Expected the latest anchor to remain rendered')
        return message.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    }, latestAnchor.id)
    expect(Math.abs(restoredOffset - latestAnchor.topOffset)).toBeLessThanOrEqual(2)
})

// At the 800-row history cap, applying another prepend evicts the newest 200
// rows. If the user reverses into that side while the request is in flight,
// invalidate the obsolete load rather than deleting their visible anchor.
test('reversing toward newer history cancels a prepend at the row cap', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?slowBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    const approachTop = async () => {
        await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
        await page.evaluate(() => {
            const element = document.querySelector('.app-scroll-y') as HTMLElement
            element.scrollTop = 0
            element.dispatchEvent(new Event('scroll'))
        })
        await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    }

    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
        await approachTop()
        await expect.poll(async () => await page.evaluate(() => ({
            beforeReqs: window.__probe.requests.filter((request) => request.direction === 'before').length,
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0
        }))).toEqual({
            beforeReqs: pageNumber,
            childCount: 200 + pageNumber * 200
        })
    }

    await page.evaluate(() => window.__probe.holdBefore())
    await approachTop()
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(4)

    const newerAnchor = await page.evaluate(() => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - 1000)
        viewport.dispatchEvent(new Event('scroll'))
        const viewportRect = viewport.getBoundingClientRect()
        const message = Array.from(
            viewport.querySelectorAll<HTMLElement>('.happy-thread-messages > [id]')
        ).find((candidate) => {
            const rect = candidate.getBoundingClientRect()
            return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
        })
        if (!message) throw new Error('Expected a visible newer-history anchor')
        return {
            id: message.id,
            topOffset: message.getBoundingClientRect().top - viewportRect.top
        }
    })
    const anchorSequence = Number(newerAnchor.id.match(/m-(\d+)/)?.[1])
    expect(anchorSequence).toBeGreaterThan(1000)

    await page.evaluate(() => window.__probe.releaseBefore())
    // The invalidated response must not apply or trim the capped window.
    await page.waitForTimeout(1000)
    const afterCancelledLoad = await page.evaluate((anchorId) => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        const message = document.getElementById(anchorId)
        return {
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
            beforeReqs: window.__probe.requests.filter((request) => request.direction === 'before').length,
            anchorOffset: message
                ? message.getBoundingClientRect().top - viewport.getBoundingClientRect().top
                : null
        }
    }, newerAnchor.id)
    expect(afterCancelledLoad).toEqual({
        childCount: 800,
        beforeReqs: 4,
        anchorOffset: expect.any(Number)
    })
    expect(Math.abs(afterCancelledLoad.anchorOffset! - newerAnchor.topOffset)).toBeLessThanOrEqual(2)
})

// The store and rendered thread must publish a capped prepend atomically. With
// throttled notification, there was a window where the store had already
// dropped m-1001…m-1200 while the DOM still exposed those rows to scrolling.
test('capped prepend has no post-apply stale-DOM reversal window', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    const approachTop = async () => {
        await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
        await page.evaluate(() => {
            const element = document.querySelector('.app-scroll-y') as HTMLElement
            element.scrollTop = 0
            element.dispatchEvent(new Event('scroll'))
        })
        await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    }

    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
        await approachTop()
        await expect.poll(async () => await page.evaluate(() => ({
            beforeReqs: window.__probe.requests.filter((request) => request.direction === 'before').length,
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0
        }))).toEqual({
            beforeReqs: pageNumber,
            childCount: 200 + pageNumber * 200
        })
    }

    await page.evaluate(() => {
        delete document.documentElement.dataset.historyStoreDomGap
        const timer = window.setInterval(() => {
            const state = window.__probe.windowState()
            if (state.oldestSeq !== 201) {
                return
            }

            const viewport = document.querySelector('.app-scroll-y') as HTMLElement
            const exposesEvictedRows = Array.from(
                viewport.querySelectorAll<HTMLElement>('.happy-thread-messages > [id]')
            ).some((message) => Number(message.id.match(/m-(\d+)/)?.[1]) > 1000)
            if (exposesEvictedRows) {
                // Reproduce the dangerous input while the DOM still exposes
                // rows that the store has already removed.
                viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - 1000)
                viewport.dispatchEvent(new Event('scroll'))
                document.documentElement.dataset.historyStoreDomGap = 'stale'
            } else {
                document.documentElement.dataset.historyStoreDomGap = 'atomic'
            }
            window.clearInterval(timer)
        }, 0)
    })

    await approachTop()
    await expect.poll(async () => await page.evaluate(() =>
        document.documentElement.dataset.historyStoreDomGap ?? null
    )).toBe('atomic')
})

// Regression: a normal tail synchronization invalidates any overlapping
// older-page request. That stop is transient: once synchronization drains,
// coverage must automatically issue a fresh request while the user remains
// near the top.
test('ordinary tail synchronization re-arms covered history loading', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?slowBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => window.__probe.holdBefore())
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)

    await page.evaluate(async () => {
        await window.__probe.refetch()
        window.__probe.releaseBefore()
    })

    await expect.poll(async () => await page.evaluate(() => ({
        beforeReqs: window.__probe.requests.filter((request) => request.direction === 'before').length,
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        scrollTop: Math.round((document.querySelector('.app-scroll-y') as HTMLElement).scrollTop)
    }))).toEqual({
        beforeReqs: 2,
        childCount: 400,
        scrollTop: expect.any(Number)
    })

    const restoredScrollTop = await viewport.evaluate((element) => Math.round(element.scrollTop))
    expect(restoredScrollTop).toBeGreaterThan(1000)
    await page.waitForTimeout(1000)
    const idleReqs = await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )
    expect(idleReqs).toBe(2)
})

// A short page can leave the top sentinel inside the preload margin after
// scroll restoration. That must not turn one approach into an opaque chain of
// older-page requests; a new approach is required for each automatic page.
test('short pages load once per top approach without automatic chaining', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?shortPages=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(2000)

    const afterFirst = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return {
            scrollTop: Math.round(el.scrollTop),
            beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
        }
    })

    expect(afterFirst.beforeReqs).toBe(1)
    expect(afterFirst.scrollTop).toBeGreaterThan(0)

    // Remaining covered and idle must not fetch the next short page.
    await page.waitForTimeout(2000)
    const idleReqs = await page.evaluate(() => window.__probe.requests.filter((r) => r.direction === 'before').length)
    expect(idleReqs).toBe(1)

    // Leave the preload area, then make a fresh approach. Exactly one more
    // page is allowed, even if that page is also too short to clear the margin.
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 500
    })
    await page.waitForTimeout(100)
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await page.evaluate(() => {
        const element = document.querySelector('.app-scroll-y') as HTMLElement
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )).toBe(2)
    await page.waitForTimeout(2000)
    const afterSecondIdle = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(afterSecondIdle).toBe(2)
})

// Regression: a failed older-page load changes no useful geometry, so no new
// scroll/resize signal is guaranteed. The same logical load must retry with
// bounded backoff without requiring another gesture.
test('a failed older-page load retries automatically while covered', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?failBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    // First attempt fails after ~50ms; backoff retries after 1000ms.
    await page.waitForTimeout(4000)

    const state = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return {
            scrollTop: Math.round(el.scrollTop),
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
            beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
        }
    })

    expect(state.beforeReqs).toBe(2)
    expect(state.childCount).toBe(400)
    expect(state.scrollTop).toBeGreaterThan(1000)
})

// Regression: when persistent failures burn through the bounded backoff, all
// automatic triggers go quiet — and at scrollTop=0 no further scroll events
// fire, so an explicit wheel-up / pull gesture is the only deterministic
// fallback left. It must route through the user-action path and recover.
test('wheel-up at the top loads older after automatic retries are exhausted', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?failBefore=4')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)
    const box = await viewport.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)

    await page.evaluate(() => {
        // Keep a non-zero position inside the preload margin. Warning
        // insertion/removal may emit browser scroll-anchoring events here;
        // those events must share the active backoff run.
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 50
    })
    // Wait for the initial attempt + 3 retries, not a rendering speed estimate.
    await expect.poll(async () => await page.evaluate(() => ({
        requests: window.__probe.requests.filter((r) => r.direction === 'before').length,
        loading: window.__probe.windowState().isLoadingMore
    }))).toEqual({ requests: 4, loading: false })
    const stuck = await page.evaluate(() => ({
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
    }))
    expect(stuck.beforeReqs).toBe(4)
    expect(stuck.childCount).toBe(200)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.mouse.wheel(0, -300)
    await expect.poll(async () => await page.evaluate(() => ({
        requests: window.__probe.requests.filter((r) => r.direction === 'before').length,
        rows: document.querySelector('.happy-thread-messages')?.childElementCount,
        restored: (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop > 1000
    }))).toEqual({ requests: 5, rows: 400, restored: true })
    const recovered = await page.evaluate(() => ({
        scrollTop: Math.round((document.querySelector('.app-scroll-y') as HTMLElement).scrollTop),
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
    }))
    expect(recovered.beforeReqs).toBe(5)
    expect(recovered.childCount).toBe(400)
    expect(recovered.scrollTop).toBeGreaterThan(1000)
})

// Regression: a page whose rows are all filtered by normalizeDecryptedMessage
// renders zero height, so the sentinel cannot move and the restore leaves
// scrollTop unchanged. Automatic loading must remain paused instead of paging
// through the entire remaining history. Filtered rows must also stay out of
// the retained message-window budget.
test('a fully filtered page keeps automatic history loading paused', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?filteredOlder=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(3000)

    const state = await page.evaluate(() => ({
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
    }))
    expect(state.beforeReqs).toBe(1)
    expect(state.childCount).toBe(200)

    // A later content shrink (the same ResizeObserver signal produced when a
    // full prepend window evicts rendered newer rows) must not revive the
    // no-progress coverage run.
    await page.evaluate(() => {
        const rows = document.querySelectorAll<HTMLElement>('.happy-thread-messages > *')
        const last = rows.item(rows.length - 1)
        if (last) last.style.display = 'none'
    })
    await page.waitForTimeout(1000)
    const afterResize = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(afterResize).toBe(1)
})

// Regression: an epoch mismatch makes the store deliberately stop the older
// load (reset + tail resync, typed stop outcome). Fresh-tail rendering can
// resize content and emit programmatic scroll signals; those signals must not
// re-arm the paused coverage run on their own.
test('an epoch-reset stop does not auto re-arm older requests', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?epochBump=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    // The stop triggers a tail resync and content resize; without the paused
    // controller state each cycle would fire another older request.
    await page.waitForTimeout(3000)

    const state = await page.evaluate(() => ({
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
    }))
    expect(state.beforeReqs).toBe(1)
    expect(state.childCount).toBe(200)

    // Scroll events can be browser/programmatic effects of a reset. Moving
    // downward while the sentinel remains covered is not renewed older-history
    // intent and must leave the automatic run paused.
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 50
    })
    await page.waitForTimeout(1000)
    const afterDownwardScroll = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(afterDownwardScroll).toBe(1)

    // A focused keyboard user can explicitly resume the paused run. Home is
    // captured before the browser-generated scroll event, so that event is
    // classified as user intent rather than reset-driven geometry.
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 500
    })
    await page.waitForTimeout(100)
    await viewport.focus()
    await viewport.press('Home')
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )).toBe(2)

    // The second request deliberately stops again. A scrollbar-style pointer
    // drag to the top is another explicit resume signal, while later
    // programmatic scroll events remain blocked.
    await page.waitForTimeout(1000)
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 500
    })
    await page.waitForTimeout(100)
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await page.evaluate(() => {
        const element = document.querySelector('.app-scroll-y') as HTMLElement
        element.scrollTop = 300
        element.dispatchEvent(new Event('scroll'))
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )).toBe(3)
})

// Touch users need visible progress before the pull gesture becomes active.
// Crossing the threshold only arms the action; the request starts on release.
test('touch pull shows staged feedback and loads older on release', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?epochBump=1&slowBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)
    await expect(page.getByText('Loading…', { exact: true })).toBeHidden()

    const dispatchTouch = async (type: 'touchstart' | 'touchmove' | 'touchend', clientY: number) => {
        await viewport.evaluate((element, eventInit) => {
            const event = new Event(eventInit.type, { bubbles: true, cancelable: true })
            Object.defineProperty(event, 'touches', {
                value: eventInit.type === 'touchend' ? [] : [{ clientY: eventInit.clientY }]
            })
            element.dispatchEvent(event)
        }, { type, clientY })
    }

    await dispatchTouch('touchstart', 100)
    await dispatchTouch('touchmove', 115)
    await expect(page.getByText('Keep pulling to load earlier messages')).toBeHidden()

    await dispatchTouch('touchmove', 116)
    await expect(page.getByText('Keep pulling to load earlier messages')).toBeVisible()
    expect(await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)

    await dispatchTouch('touchmove', 164)
    await expect(page.getByText('Release to load earlier messages')).toBeVisible()
    expect(await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)

    await page.evaluate(() => window.__probe.holdBefore())
    await dispatchTouch('touchend', 164)
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(2)
    await expect(page.getByText('Loading…', { exact: true })).toBeVisible()
    await page.evaluate(() => window.__probe.releaseBefore())
    await expect(page.getByText('Loading…', { exact: true })).toBeHidden()
})

// Regression: scroll/resize signals emitted while a failed page is in backoff
// must join the same logical load. The delayed retry may discover an epoch
// reset, which then stops the run without a third request.
test('scroll events cannot bypass backoff before an epoch-reset stop', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-01-01T08:00:00Z') })
    await page.goto('/e2e-fixtures/history-load-fixture.html?failBefore=1&epochBump=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)
    await page.clock.pauseAt(new Date('2026-01-01T08:10:00Z'))

    await page.evaluate(() => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        viewport.scrollTop = 0
        viewport.dispatchEvent(new Event('scroll'))
    })
    await page.clock.runFor(250)
    await expect(page.getByText('fixture: forced before-page failure')).toBeVisible()

    // Programmatic/browser scroll signals during backoff must not start an
    // immediate second request.
    await page.evaluate(() => {
        const viewport = document.querySelector('.app-scroll-y')
        viewport?.dispatchEvent(new Event('scroll'))
        viewport?.dispatchEvent(new Event('scroll'))
    })
    await page.clock.runFor(400)
    const duringBackoff = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(duringBackoff).toBe(1)

    // The controller-owned 1s retry returns the deliberate epoch-reset stop.
    await page.clock.resume()
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )).toBe(2)
    const requestTimes = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').map((r) => r.at)
    )
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1000)

    await page.waitForTimeout(1500)
    const afterStop = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(afterStop).toBe(2)
})
