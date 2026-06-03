/*
 * End-to-end coverage for the per-session scratchlist (issue #11 / PR
 * #772). The unit tests in `web/src/components/AssistantChat/
 * ScratchlistPanel.test.tsx` exercise the component under jsdom, which
 * does not honor `inert` for focus blocking, does not run the CSS
 * `grid-template-rows` collapse animation, and does not exercise real
 * `localStorage` round-tripping across full page loads.
 *
 * These specs drive a real Chromium against the
 * `web/e2e-fixtures/scratchlist-fixture.html` page (vite dev), which
 * mounts the production ScratchlistPanel + I18nProvider with stub
 * promote callbacks exposed on `window.__scratchlistE2E`.
 *
 * Each test uses a unique `?session=...` query param so the keyed
 * localStorage state is naturally isolated.
 */

import { test, expect, Page } from '@playwright/test'

type Harness = {
    sessionId: string
    promotedToComposer: string[]
    promotedToQueue: string[]
    queueSendMode: 'success' | 'failure'
}

async function gotoFixture(page: Page, sessionId: string): Promise<void> {
    // We use a unique session id per test (the localStorage keys are
    // namespaced by sessionId), so isolation is naturally per-test
    // without needing to clear storage. Clearing on every page load
    // would defeat the persistence + cross-navigation tests below.
    await page.goto(`/e2e-fixtures/scratchlist-fixture.html?session=${encodeURIComponent(sessionId)}`)
    await expect(page.getByTestId('scratchlist-panel')).toBeVisible()
}

async function readHarness(page: Page): Promise<Harness> {
    return await page.evaluate(() => {
        const h = window.__scratchlistE2E!
        return {
            sessionId: h.sessionId,
            promotedToComposer: [...h.promotedToComposer],
            promotedToQueue: [...h.promotedToQueue],
            queueSendMode: h.queueSendMode,
        }
    })
}

async function setQueueMode(page: Page, mode: 'success' | 'failure'): Promise<void> {
    await page.evaluate((m) => {
        if (window.__scratchlistE2E) {
            window.__scratchlistE2E.queueSendMode = m
        }
    }, mode)
}

async function expandPanel(page: Page): Promise<void> {
    const toggle = page.getByRole('button', { name: 'Scratchlist' })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.click()
    }
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
}

async function collapsePanel(page: Page): Promise<void> {
    const toggle = page.getByRole('button', { name: 'Scratchlist' })
    if ((await toggle.getAttribute('aria-expanded')) !== 'false') {
        await toggle.click()
    }
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
}

async function addEntry(page: Page, text: string): Promise<void> {
    const textarea = page.getByLabel('Add scratchlist entry')
    await textarea.fill(text)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(textarea).toHaveValue('')
}

test.describe('scratchlist e2e', () => {
    test('starts collapsed, expands on click, collapses on second click', async ({ page }) => {
        await gotoFixture(page, 'expand')

        const toggle = page.getByRole('button', { name: 'Scratchlist' })
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')

        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')

        await toggle.click()
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    })

    test('collapsed inner is `inert`: textarea cannot be focused or clicked', async ({ page }) => {
        // This is the regression that the upstream PR review flagged.
        // jsdom can't verify it; only a real browser can.
        await gotoFixture(page, 'inert')

        const inner = page.locator('.collapsible-inner').first()
        await expect(inner).toHaveAttribute('inert', '')

        // Try to focus the (collapsed) textarea. Per the HTML spec, an
        // inert subtree refuses focus.
        const textarea = page.getByLabel('Add scratchlist entry')
        await textarea.focus({ timeout: 1_000 }).catch(() => {})
        const focusedTagCollapsed = await page.evaluate(
            () => document.activeElement?.tagName ?? 'NONE'
        )
        expect(focusedTagCollapsed).not.toBe('TEXTAREA')

        // Clicks on inert children also have no effect: the panel must
        // not collapse / submit / fill, the click is swallowed.
        await textarea.click({ force: true, timeout: 1_000 }).catch(() => {})
        const stillCollapsed = await page
            .getByRole('button', { name: 'Scratchlist' })
            .getAttribute('aria-expanded')
        expect(stillCollapsed).toBe('false')

        // Expand and confirm focus works again.
        await expandPanel(page)
        const innerAttrAfter = await inner.getAttribute('inert')
        expect(innerAttrAfter === null || innerAttrAfter === '' || innerAttrAfter === 'false').toBeTruthy()
        await textarea.focus()
        const focusedAfter = await page.evaluate(
            () => document.activeElement?.tagName ?? 'NONE'
        )
        expect(focusedAfter).toBe('TEXTAREA')
    })

    test('add: entry appears, draft clears, count updates', async ({ page }) => {
        await gotoFixture(page, 'add')
        await expandPanel(page)

        // Initial summary is "empty".
        await expect(page.getByText('empty', { exact: true })).toBeVisible()

        await addEntry(page, 'Investigate the runner cold-start delay')

        await expect(page.getByText('Investigate the runner cold-start delay')).toBeVisible()
        await expect(page.getByText('1 item', { exact: true })).toBeVisible()

        await addEntry(page, 'Second draft')
        await expect(page.getByText('2 items', { exact: true })).toBeVisible()
    })

    test('persistence: entries survive a full page reload', async ({ page }) => {
        await gotoFixture(page, 'persist')
        await expandPanel(page)
        await addEntry(page, 'First note')
        await addEntry(page, 'Second note')

        await page.reload()
        await expect(page.getByTestId('scratchlist-panel')).toBeVisible()

        // Collapsed-state preference is also remembered, so we expand
        // again before asserting both entries reappear. The storage
        // layer renders newest-first, so the most recent add is at
        // index 0.
        await expandPanel(page)
        const items = page.locator('[data-testid="scratchlist-entry"]')
        await expect(items).toHaveCount(2)
        await expect(items.nth(0)).toContainText('Second note')
        await expect(items.nth(1)).toContainText('First note')
    })

    test('promote-to-composer fires callback with entry text', async ({ page }) => {
        await gotoFixture(page, 'promote-composer')
        await expandPanel(page)
        await addEntry(page, 'Draft a status update')

        await page.getByRole('button', { name: 'Copy into composer' }).first().click()

        const harness = await readHarness(page)
        expect(harness.promotedToComposer).toEqual(['Draft a status update'])
        // Promote-to-composer is a copy: the entry stays.
        await expect(page.getByText('Draft a status update')).toBeVisible()
    })

    test('promote-to-queue (success) fires callback and removes entry', async ({ page }) => {
        await gotoFixture(page, 'promote-queue')
        await expandPanel(page)
        await addEntry(page, 'Ship the patch release')

        await setQueueMode(page, 'success')
        await page.getByRole('button', { name: 'Send to queue' }).first().click()

        await expect(page.getByText('Ship the patch release')).toHaveCount(0)
        const harness = await readHarness(page)
        expect(harness.promotedToQueue).toEqual(['Ship the patch release'])
    })

    test('promote-to-queue (failure) keeps the entry on the scratchlist', async ({ page }) => {
        await gotoFixture(page, 'promote-queue-fail')
        await expandPanel(page)
        await addEntry(page, 'This send will fail')

        await setQueueMode(page, 'failure')
        await page.getByRole('button', { name: 'Send to queue' }).first().click()

        // Failure path: the queue callback returned false, so the entry
        // must remain on the scratchlist (operator can retry).
        await expect(page.getByText('This send will fail')).toBeVisible()
        const harness = await readHarness(page)
        expect(harness.promotedToQueue).toEqual([])
    })

    test('Ctrl+Shift+S expands the panel and focuses the input', async ({ page }) => {
        await gotoFixture(page, 'shortcut')
        await collapsePanel(page)

        await page.keyboard.press('Control+Shift+S')

        await expect(page.getByRole('button', { name: 'Scratchlist' })).toHaveAttribute(
            'aria-expanded',
            'true'
        )
        await expect.poll(
            async () => page.evaluate(() => document.activeElement?.tagName ?? 'NONE'),
            { timeout: 2_000 }
        ).toBe('TEXTAREA')
    })

    test('per-session isolation: switching sessions does not leak entries', async ({ page }) => {
        await gotoFixture(page, 'session-a')
        await expandPanel(page)
        await addEntry(page, 'Note for session A')

        // Navigate to a different session id; localStorage is keyed by
        // `hapi.scratchlist.v1.<sessionId>`, so session B must start
        // empty even though A still has its entry persisted.
        await page.goto(`/e2e-fixtures/scratchlist-fixture.html?session=session-b`)
        await expect(page.getByTestId('scratchlist-panel')).toBeVisible()
        await expandPanel(page)
        await expect(page.getByText('empty', { exact: true })).toBeVisible()
        await expect(page.getByText('Note for session A')).toHaveCount(0)

        // And navigating back to A still shows its note.
        await page.goto(`/e2e-fixtures/scratchlist-fixture.html?session=session-a`)
        await expandPanel(page)
        await expect(page.getByText('Note for session A')).toBeVisible()
    })
})
