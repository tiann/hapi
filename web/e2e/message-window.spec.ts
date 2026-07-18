import { expect, test, type Page } from '@playwright/test'
import type {
    MessageWindowHarnessSnapshot as HarnessSnapshot,
    MessageWindowScenario,
} from './harness-types'

test.use({ serviceWorkers: 'block' })

async function snapshot(page: Page): Promise<HarnessSnapshot> {
    return await page.evaluate(() => window.hapiE2E.snapshot())
}

async function openHarness(
    page: Page,
    scenario: MessageWindowScenario = 'tool-dense',
) {
    await page.goto(`/e2e/fixtures/message-window.html?scenario=${scenario}`)
    await expect(page.getByTestId('message-window-harness')).toBeVisible()
    await page.evaluate(async () => window.hapiE2E.ready())
}

async function firstVisibleAnchor(page: Page): Promise<{ id: string; top: number }> {
    return await page.locator('.app-scroll-y').evaluate((viewport) => {
        const viewportRect = viewport.getBoundingClientRect()
        const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-hapi-message-id]'))
        const row = rows.find((candidate) => {
            const rect = candidate.getBoundingClientRect()
            return rect.bottom >= viewportRect.top && rect.top <= viewportRect.bottom
        })
        if (!row?.dataset.hapiMessageId) {
            throw new Error('No visible stable message anchor')
        }
        return {
            id: row.dataset.hapiMessageId,
            top: row.getBoundingClientRect().top - viewportRect.top,
        }
    })
}

async function settleLayout(page: Page, frames = 4): Promise<void> {
    await page.evaluate(async (frameCount) => {
        for (let frame = 0; frame < frameCount; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
    }, frames)
}

async function scrollViewport(page: Page, edge: 'top' | 'bottom'): Promise<void> {
    await page.locator('.app-scroll-y').evaluate(async (viewport, targetEdge) => {
        let stableFrames = 0
        const samples: Array<Record<string, unknown>> = []
        viewport.dispatchEvent(new WheelEvent('wheel', {
            deltaY: targetEdge === 'top' ? -120 : 120,
        }))
        for (let attempt = 0; attempt < 20; attempt += 1) {
            viewport.scrollTop = targetEdge === 'top' ? 0 : viewport.scrollHeight
            viewport.dispatchEvent(new Event('scroll'))
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
            const distance = targetEdge === 'top'
                ? viewport.scrollTop
                : viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
            const rows = Array.from(viewport.querySelectorAll<HTMLElement>('[data-hapi-message-id]'))
            samples.push({
                attempt,
                scrollTop: viewport.scrollTop,
                scrollHeight: viewport.scrollHeight,
                clientHeight: viewport.clientHeight,
                distance,
                firstMountedId: rows.at(0)?.dataset.hapiMessageId ?? null,
                lastMountedId: rows.at(-1)?.dataset.hapiMessageId ?? null,
                tailSpacer: viewport.querySelector<HTMLElement>('[data-testid="anchor-tail-spacer"]')?.offsetHeight ?? 0,
            })
            stableFrames = Math.abs(distance) <= 1 ? stableFrames + 1 : 0
            if (stableFrames >= 2) {
                return
            }
        }
        throw new Error(`Failed to hold the message viewport at the ${targetEdge} edge: ${JSON.stringify(samples)}`)
    }, edge)
}

async function expectStableAnchor(
    page: Page,
    anchor: { id: string; top: number },
): Promise<void> {
    await settleLayout(page)
    const anchorDeviation = async () => {
        const row = page.locator(`[data-hapi-message-id="${anchor.id}"]`)
        if (await row.count() === 0) return Number.POSITIVE_INFINITY
        const top = await row.evaluate((element) => {
            const viewport = element.closest('.app-scroll-y')!
            return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top
        })
        return Math.abs(top - anchor.top)
    }
    await expect.poll(anchorDeviation).toBeLessThanOrEqual(2)
    // HappyThread keeps correcting through a bounded stable-frame window.
    // Observe two more frames after the first exact sample and ensure a late
    // virtualizer measurement cannot move the reading position.
    await settleLayout(page, 2)
    expect(await anchorDeviation()).toBeLessThanOrEqual(2)
}

test('1,000 tool pairs remain complete across cold load, reconnect, review streaming, and exact latest', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await openHarness(page)
    await expect.poll(async () => (await snapshot(page)).rawCount).toBe(2_002)
    let state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 2_002,
        pendingCount: 0,
        firstSeq: 83,
        lastSeq: 2_084,
        duplicateCount: 0,
        gaps: [],
        hasOlder: true,
        hasNewer: false,
        sseConnected: true,
    })
    expect(state.pageRequests).toEqual([{
        beforeSeq: null,
        afterSeq: null,
        limit: 50,
        responseCount: 2_002,
        startComplete: true,
        endComplete: true,
    }])
    await expect(page.getByText('STRESS_QUESTION')).toBeVisible()
    await expect(page.getByText('STRESS_FINAL_ANSWER')).toBeVisible()
    await expect(page.getByText('1000 个工具调用')).toBeVisible()

    await page.getByText('1000 个工具调用').click()
    await expect(page.getByTestId('tool-card')).toHaveCount(1_000)
    const pairIds = await page.getByTestId('tool-card').evaluateAll((cards) => (
        cards
            .map((card) => card.textContent?.match(/pair-(\d+)/)?.[1] ?? null)
            .filter((value): value is string => value !== null)
    ))
    expect(new Set(pairIds).size).toBe(1_000)
    expect(pairIds).toContain('0')
    expect(pairIds).toContain('999')

    await scrollViewport(page, 'top')
    await page.getByRole('button', { name: 'Terminal echo pair-0', exact: true }).click()
    let toolDialog = page.getByRole('dialog')
    await expect(toolDialog).toContainText('echo pair-0')
    await expect(toolDialog).toContainText('pair-0-result')
    await expect(toolDialog.getByTestId('tool-raw-input-payload')).toContainText('pair-0-input-sentinel')
    await expect(toolDialog.getByTestId('tool-raw-result-payload')).toContainText('pair-0-result-sentinel')
    await page.keyboard.press('Escape')
    await expect(toolDialog).toBeHidden()

    await scrollViewport(page, 'bottom')
    await page.getByRole('button', { name: 'Terminal echo pair-999', exact: true }).click()
    toolDialog = page.getByRole('dialog')
    await expect(toolDialog).toContainText('echo pair-999')
    await expect(toolDialog).toContainText('pair-999-result')
    await expect(toolDialog.getByTestId('tool-raw-input-payload')).toContainText('pair-999-input-sentinel')
    await expect(toolDialog.getByTestId('tool-raw-result-payload')).toContainText('pair-999-result-sentinel')
    await page.keyboard.press('Escape')
    await expect(toolDialog).toBeHidden()

    await page.getByText('1000 个工具调用').click()
    await expect(page.getByTestId('tool-card')).toHaveCount(0)

    const firstSubscriptionId = state.sseSubscriptionId
    expect(firstSubscriptionId).not.toBeNull()
    await page.evaluate(() => window.hapiE2E.prepareReconnect())
    await page.reload()
    await expect(page.getByTestId('message-window-harness')).toBeVisible()
    await page.evaluate(async () => window.hapiE2E.ready())
    await expect.poll(async () => (await snapshot(page)).rawCount).toBe(2_002)
    state = await snapshot(page)
    expect(state.gaps).toEqual([])
    expect(state.duplicateCount).toBe(0)
    expect(state.sseSubscriptionId).not.toBe(firstSubscriptionId)
    expect(state.pageRequests).toHaveLength(2)
    expect(state.pageRequests[1]).toMatchObject({
        beforeSeq: null,
        afterSeq: null,
        limit: 50,
        responseCount: 2_002,
    })

    const olderSteps = [
        { beforeSeq: 83, responseCount: 20, rawCount: 2_022, firstSeq: 63, lastSeq: 2_084, hasNewer: false },
        { beforeSeq: 63, responseCount: 20, rawCount: 2_042, firstSeq: 43, lastSeq: 2_084, hasNewer: false },
        { beforeSeq: 43, responseCount: 20, rawCount: 2_062, firstSeq: 23, lastSeq: 2_084, hasNewer: false },
        { beforeSeq: 23, responseCount: 20, rawCount: 80, firstSeq: 3, lastSeq: 82, hasNewer: true },
        { beforeSeq: 3, responseCount: 2, rawCount: 80, firstSeq: 1, lastSeq: 80, hasNewer: true },
    ] as const
    for (const step of olderSteps) {
        await scrollViewport(page, 'top')
        const anchor = await firstVisibleAnchor(page)
        await page.getByRole('button', { name: 'Load older' }).click()
        await expect.poll(async () => (await snapshot(page)).firstSeq).toBe(step.firstSeq)
        await expectStableAnchor(page, anchor)
        state = await snapshot(page)
        expect(state).toMatchObject({
            rawCount: step.rawCount,
            firstSeq: step.firstSeq,
            lastSeq: step.lastSeq,
            duplicateCount: 0,
            gaps: [],
            hasNewer: step.hasNewer,
        })
        expect(state.pageRequests.at(-1)).toMatchObject({
            beforeSeq: step.beforeSeq,
            afterSeq: null,
            limit: 20,
            responseCount: step.responseCount,
        })
    }
    expect(state).toMatchObject({
        rawCount: 80,
        firstSeq: 1,
        lastSeq: 80,
        duplicateCount: 0,
        gaps: [],
        hasOlder: false,
        hasNewer: true,
    })
    await scrollViewport(page, 'bottom')
    const newerAnchor = await firstVisibleAnchor(page)
    await page.getByRole('button', { name: 'Load newer' }).click()
    await expect.poll(async () => (await snapshot(page)).lastSeq).toBe(2_084)
    await expectStableAnchor(page, newerAnchor)
    state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 2_080,
        firstSeq: 5,
        lastSeq: 2_084,
        duplicateCount: 0,
        gaps: [],
        hasOlder: true,
        hasNewer: false,
    })
    expect(state.pageRequests.at(-1)).toMatchObject({
        beforeSeq: null,
        afterSeq: 80,
        limit: 20,
        responseCount: 2_004,
    })

    await scrollViewport(page, 'top')
    await expect.poll(async () => (await snapshot(page)).atBottom).toBe(false)
    const reviewAnchor = await firstVisibleAnchor(page)
    const reviewResult = await page.evaluate(() => window.hapiE2E.reviewAndStream(1_000))
    expect(reviewResult.sameVisibleReference).toBe(true)
    expect(reviewResult.sameVisibleOrder).toBe(true)
    state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 2_080,
        pendingCount: 1_000,
        firstSeq: 5,
        lastSeq: 2_084,
        sseEmittedCount: 1_000,
        sseReceivedCount: 1_000,
    })
    await expectStableAnchor(page, reviewAnchor)

    const newMessagesButton = page.getByRole('button').filter({ hasText: '1000' })
    await expect(newMessagesButton).toHaveCount(1)
    await newMessagesButton.click()
    await expect.poll(async () => (await snapshot(page)).pendingCount).toBe(0)
    await expect.poll(async () => (await snapshot(page)).rawCount).toBe(3_002)
    await expect.poll(async () => (await snapshot(page)).blockCount).toBe(2_002)
    state = await snapshot(page)
    expect(state).toMatchObject({
        firstSeq: 83,
        lastSeq: 3_084,
        atBottom: true,
    })
    expect(state.gaps).toEqual([])
    expect(state.duplicateCount).toBe(0)
    expect(state.pageRequests.at(-1)).toMatchObject({
        beforeSeq: null,
        afterSeq: null,
        limit: 50,
        responseCount: 3_002,
    })
    await expect(page.getByText('STREAM_EVENT_999')).toBeVisible()
    expect(pageErrors).toEqual([])
})

test('older and newer navigation preserves an exact stable anchor and continuous ranges', async ({ page }) => {
    await openHarness(page, 'history')
    await expect.poll(async () => (await snapshot(page)).rawCount).toBe(50)
    await scrollViewport(page, 'top')
    await expect.poll(async () => {
        try {
            await firstVisibleAnchor(page)
            return true
        } catch {
            return false
        }
    }).toBe(true)
    const before = await firstVisibleAnchor(page)

    await page.getByRole('button', { name: 'Load older' }).click()
    await expect.poll(async () => (await snapshot(page)).firstSeq).toBe(13)
    await expectStableAnchor(page, before)
    let state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 70,
        firstSeq: 13,
        lastSeq: 82,
        duplicateCount: 0,
        gaps: [],
        hasOlder: true,
        hasNewer: false,
    })
    expect(state.pageRequests.at(-1)).toMatchObject({
        beforeSeq: 33,
        afterSeq: null,
        limit: 20,
        responseCount: 20,
    })

    await scrollViewport(page, 'top')
    const secondOlderAnchor = await firstVisibleAnchor(page)
    await page.getByRole('button', { name: 'Load older' }).click()
    await expect.poll(async () => (await snapshot(page)).firstSeq).toBe(1)
    await expectStableAnchor(page, secondOlderAnchor)
    state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 80,
        firstSeq: 1,
        lastSeq: 80,
        duplicateCount: 0,
        gaps: [],
        hasOlder: false,
        hasNewer: true,
    })
    expect(state.pageRequests.at(-1)).toMatchObject({
        beforeSeq: 13,
        afterSeq: null,
        limit: 20,
        responseCount: 12,
    })

    await scrollViewport(page, 'bottom')
    const newerAnchor = await firstVisibleAnchor(page)
    await page.getByRole('button', { name: 'Load newer' }).click()
    await expect.poll(async () => (await snapshot(page)).lastSeq).toBe(82)
    await expectStableAnchor(page, newerAnchor)
    state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 80,
        firstSeq: 3,
        lastSeq: 82,
        duplicateCount: 0,
        gaps: [],
        hasOlder: true,
        hasNewer: false,
    })
    expect(state.pageRequests.at(-1)).toMatchObject({
        beforeSeq: null,
        afterSeq: 80,
        limit: 20,
        responseCount: 2,
    })
})

test('an under-capacity older merge stays live and renders the next SSE message immediately', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await openHarness(page, 'history')
    await expect.poll(async () => (await snapshot(page)).rawCount).toBe(50)

    await scrollViewport(page, 'top')
    const anchor = await firstVisibleAnchor(page)
    await page.getByRole('button', { name: 'Load older' }).click()
    await expect.poll(async () => (await snapshot(page)).firstSeq).toBe(13)
    await expectStableAnchor(page, anchor)

    let state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 70,
        firstSeq: 13,
        lastSeq: 82,
        hasOlder: true,
        hasNewer: false,
        pendingCount: 0,
        gaps: [],
    })

    await scrollViewport(page, 'bottom')
    await expect.poll(async () => (await snapshot(page)).atBottom).toBe(true)
    await page.evaluate(() => window.hapiE2E.streamAtLiveBottom(1))
    await expect.poll(async () => (await snapshot(page)).lastSeq).toBe(83)

    state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 71,
        lastSeq: 83,
        hasNewer: false,
        pendingCount: 0,
        sseEmittedCount: 1,
        sseReceivedCount: 1,
    })
    expect(state.gaps).toEqual([])
    expect(state.duplicateCount).toBe(0)
    await expect(page.getByText('STREAM_EVENT_0')).toBeVisible()
    expect(pageErrors).toEqual([])
})

test('an in-place SSE reconnect refreshes messages stored during the disconnect gap', async ({
    page,
    request,
}) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await openHarness(page, 'live-cap')
    const before = await snapshot(page)
    expect(before).toMatchObject({
        rawCount: 40,
        firstSeq: 1,
        lastSeq: 40,
        gaps: [],
        duplicateCount: 0,
    })
    expect(before.sseSubscriptionId).not.toBeNull()

    await page.evaluate(() => window.hapiE2E.disconnectSse())
    const gapResponse = await request.post('http://127.0.0.1:4179/api/__e2e/stream', {
        data: {
            count: 1,
            kind: 'user-turns',
            broadcast: false,
        },
    })
    expect(gapResponse.ok()).toBe(true)

    await expect.poll(
        async () => (await snapshot(page)).sseSubscriptionId,
        { timeout: 15_000 },
    ).not.toBe(before.sseSubscriptionId)
    await expect.poll(
        async () => (await snapshot(page)).lastSeq,
        { timeout: 15_000 },
    ).toBe(41)

    const after = await snapshot(page)
    expect(after).toMatchObject({
        rawCount: 40,
        firstSeq: 2,
        lastSeq: 41,
        hasOlder: true,
        hasNewer: false,
        gaps: [],
        duplicateCount: 0,
    })
    expect(pageErrors).toEqual([])
})

test('a live turn beyond the 40-turn cap stays reachable through real history paging', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await openHarness(page, 'live-cap')

    let state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 40,
        firstSeq: 1,
        lastSeq: 40,
        hasOlder: false,
        hasNewer: false,
        pendingCount: 0,
        gaps: [],
    })

    await scrollViewport(page, 'bottom')
    await expect.poll(async () => (await snapshot(page)).atBottom).toBe(true)
    await page.evaluate(() => window.hapiE2E.streamAtLiveBottom(1, { newTurns: true }))
    await expect.poll(async () => (await snapshot(page)).lastSeq).toBe(41)

    state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 40,
        firstSeq: 2,
        lastSeq: 41,
        hasOlder: true,
        hasNewer: false,
        pendingCount: 0,
        sseEmittedCount: 1,
        sseReceivedCount: 1,
    })
    await expect(page.getByText('STREAM_USER_TURN_0')).toBeVisible()

    await scrollViewport(page, 'top')
    const anchor = await firstVisibleAnchor(page)
    await page.getByRole('button', { name: 'Load older' }).click()
    await expect.poll(async () => (await snapshot(page)).firstSeq).toBe(1)
    await expectStableAnchor(page, anchor)

    state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 40,
        firstSeq: 1,
        lastSeq: 40,
        hasOlder: false,
        hasNewer: true,
        duplicateCount: 0,
        gaps: [],
    })
    expect(state.pageRequests.at(-1)).toMatchObject({
        beforeSeq: 2,
        afterSeq: null,
        limit: 20,
        responseCount: 1,
    })
    await expect(page.getByText('LIVE_CAP_TURN_1', { exact: true })).toBeVisible()
    expect(pageErrors).toEqual([])
})

test('100 one-row turns stay reachable with stable anchors in both directions', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await openHarness(page, 'single-row-history')
    let state = await snapshot(page)
    expect(state).toMatchObject({
        rawCount: 40,
        firstSeq: 61,
        lastSeq: 100,
        duplicateCount: 0,
        gaps: [],
        hasOlder: true,
        hasNewer: false,
    })
    expect(state.pageRequests).toEqual([expect.objectContaining({
        beforeSeq: null,
        afterSeq: null,
        limit: 50,
        responseCount: 50,
    })])

    const visited = new Set(state.sequences)
    while (state.hasOlder) {
        await scrollViewport(page, 'top')
        const anchor = await firstVisibleAnchor(page)
        const previousSequences = new Set(state.sequences)
        const requestCount = state.pageRequests.length

        await page.getByRole('button', { name: 'Load older' }).click()
        await expect.poll(async () => (await snapshot(page)).pageRequests.length).toBe(requestCount + 1)
        await expectStableAnchor(page, anchor)
        state = await snapshot(page)

        expect(state.pageRequests.at(-1)).toMatchObject({
            afterSeq: null,
            limit: 20,
            responseCount: 20,
        })
        expect(state.duplicateCount).toBe(0)
        expect(state.gaps).toEqual([])
        expect(state.sequences.some((seq) => previousSequences.has(seq))).toBe(true)
        for (const seq of state.sequences) visited.add(seq)
    }

    expect(state).toMatchObject({ firstSeq: 1, lastSeq: 40, hasOlder: false, hasNewer: true })
    expect([...visited].sort((left, right) => left - right)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 1),
    )

    while (state.hasNewer) {
        await scrollViewport(page, 'bottom')
        const anchor = await firstVisibleAnchor(page)
        const previousSequences = new Set(state.sequences)
        const requestCount = state.pageRequests.length

        await page.getByRole('button', { name: 'Load newer' }).click()
        await expect.poll(async () => (await snapshot(page)).pageRequests.length).toBe(requestCount + 1)
        await expectStableAnchor(page, anchor)
        state = await snapshot(page)

        expect(state.pageRequests.at(-1)).toMatchObject({
            beforeSeq: null,
            limit: 20,
        })
        expect(state.duplicateCount).toBe(0)
        expect(state.gaps).toEqual([])
        expect(state.sequences.some((seq) => previousSequences.has(seq))).toBe(true)
    }

    expect(state).toMatchObject({ firstSeq: 61, lastSeq: 100, hasOlder: true, hasNewer: false })
    expect(pageErrors).toEqual([])
})

test('10,000 normalized blocks keep bounded mounts and navigate to the final target within five seconds', async ({ page }) => {
    await openHarness(page, 'ten-thousand')
    await expect.poll(async () => (await snapshot(page)).rawCount, { timeout: 20_000 }).toBe(10_000)
    await expect.poll(async () => (await snapshot(page)).blockCount, { timeout: 20_000 }).toBe(10_000)
    const state = await snapshot(page)
    expect(state.pageRequests).toEqual([{
        beforeSeq: null,
        afterSeq: null,
        limit: 50,
        responseCount: 10_000,
        startComplete: true,
        endComplete: true,
    }])
    await expect.poll(async () => page.getByTestId('virtual-thread-row').count()).toBeGreaterThan(0)
    expect(await page.getByTestId('virtual-thread-row').count()).toBeLessThan(100)

    await page.locator('.app-scroll-y').evaluate((viewport) => {
        viewport.scrollTop = viewport.scrollHeight
        viewport.dispatchEvent(new Event('scroll'))
    })
    await expect(page.getByText('VIRTUAL_FINAL_10000')).toBeVisible({ timeout: 5_000 })
    expect(await page.getByTestId('virtual-thread-row').count()).toBeLessThan(100)
})
