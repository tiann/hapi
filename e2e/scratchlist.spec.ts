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
 * mounts the production ScratchlistPanel + I18nProvider.
 *
 * Each test uses a unique `?session=...` query param so the keyed
 * localStorage state is naturally isolated.
 */

import { test, expect, Page } from '@playwright/test'

async function gotoFixture(page: Page, sessionId: string): Promise<void> {
    // We use a unique session id per test (the localStorage keys are
    // namespaced by sessionId), so isolation is naturally per-test
    // without needing to clear storage. Clearing on every page load
    // would defeat the persistence + cross-navigation tests below.
    await page.goto(`/e2e-fixtures/scratchlist-fixture.html?session=${encodeURIComponent(sessionId)}`)
    await expect(page.getByTestId('scratchlist-panel')).toBeVisible()
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

    test('clicking an entry text opens inline editing and Enter saves it', async ({ page }) => {
        await gotoFixture(page, 'inline-edit')
        await expandPanel(page)
        await addEntry(page, 'Draft a status update\nwith a second line')

        await page.getByTestId('scratchlist-entry-text').click()
        const editor = page.getByRole('textbox', { name: 'Edit scratchlist entry' })
        await expect(editor).toBeFocused()
        await expect(editor).toHaveJSProperty('selectionStart', 'Draft a status update\nwith a second line'.length)
        await expect(editor).toHaveJSProperty('selectionEnd', 'Draft a status update\nwith a second line'.length)
        await expect(editor).toHaveCSS('overflow-y', 'hidden')
        await expect.poll(async () => await editor.evaluate((element) => element.clientHeight >= element.scrollHeight)).toBe(true)
        await editor.fill('Updated status update')
        await editor.press('Enter')

        await expect(page.getByTestId('scratchlist-entry-text')).toHaveText('Updated status update')
    })

    test('long-press drag reorders entries and removes the old row actions', async ({ page }) => {
        await gotoFixture(page, 'long-press-reorder')
        await expandPanel(page)
        await addEntry(page, 'First note')
        await addEntry(page, 'Second note')
        await addEntry(page, 'Third note')

        await expect(page.getByRole('button', { name: 'Move entry up' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Move entry down' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Copy into composer' })).toHaveCount(0)
        await expect(page.getByRole('button', { name: 'Send to queue' })).toHaveCount(0)
        await expect(page.getByTestId('scratchlist-entry-age')).toHaveCount(0)

        const rows = page.getByTestId('scratchlist-entry')
        const source = rows.nth(0)
        const destination = rows.nth(2)
        const sourceBox = await source.boundingBox()
        const destinationBox = await destination.boundingBox()
        expect(sourceBox).not.toBeNull()
        expect(destinationBox).not.toBeNull()
        await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2)
        await page.mouse.down()
        await page.waitForTimeout(550)
        await page.mouse.move(destinationBox!.x + destinationBox!.width / 2, destinationBox!.y + destinationBox!.height / 2)
        await page.mouse.up()

        await expect(rows.nth(0)).toContainText('Second note')
        await expect(rows.nth(1)).toContainText('First note')
        await expect(rows.nth(2)).toContainText('Third note')
    })

    test('mobile touch long-press drag reorders entries', async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width: 412, height: 800 },
            hasTouch: true,
            isMobile: true,
        })
        const page = await context.newPage()
        try {
            await gotoFixture(page, 'mobile-touch-reorder')
            await expandPanel(page)
            await addEntry(page, 'First note')
            await addEntry(page, 'Second note')
            await addEntry(page, 'Third note')

            const rows = page.getByTestId('scratchlist-entry')
            const sourceBox = await rows.nth(0).boundingBox()
            const destinationBox = await rows.nth(2).boundingBox()
            expect(sourceBox).not.toBeNull()
            expect(destinationBox).not.toBeNull()

            const client = await context.newCDPSession(page)
            const sourceX = sourceBox!.x + sourceBox!.width / 2
            const sourceY = sourceBox!.y + sourceBox!.height / 2
            const destinationX = destinationBox!.x + destinationBox!.width / 2
            const destinationY = destinationBox!.y + destinationBox!.height / 2
            const touchPoint = (x: number, y: number) => ({
                x,
                y,
                id: 1,
                radiusX: 1,
                radiusY: 1,
                force: 1,
            })

            await client.send('Input.dispatchTouchEvent', {
                type: 'touchStart',
                touchPoints: [touchPoint(sourceX, sourceY)],
            })
            await page.waitForTimeout(550)
            await client.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [touchPoint(destinationX, destinationY)],
            })
            await client.send('Input.dispatchTouchEvent', {
                type: 'touchEnd',
                touchPoints: [],
            })

            await expect(rows.nth(0)).toContainText('Second note')
            await expect(rows.nth(1)).toContainText('First note')
            await expect(rows.nth(2)).toContainText('Third note')
            await expect(page.getByRole('textbox', { name: 'Edit scratchlist entry' })).toHaveCount(0)
            await expect(page.getByTestId('scratchlist-action-menu')).toHaveCount(0)
        } finally {
            await context.close()
        }
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

    test('regression: in-place sessionId change does not leak entries (host keyed by sessionId)', async ({ page }) => {
        // Reproduces the bug flagged by the upstream PR review:
        // ScratchlistPanel reads `sessionId` once via useState and
        // rehydrates in useEffect. If a parent stays mounted across
        // session changes (SessionChat does, on same-route nav), the
        // persist effect for the stale entries fires under the new
        // sessionId BEFORE the rehydrate effect's setEntries triggers a
        // correction render. That race writes A's entries into B's
        // localStorage, even though the second render then overwrites
        // it with [] - leaving a transient bad write in storage that
        // a tab/network race could observe.
        //
        // Reading localStorage AFTER the dust settles is too late: the
        // bug write has already been overwritten by the correction
        // write. We instead install a setItem spy BEFORE mount so every
        // write during the session switch is recorded, then assert no
        // write to the new sessionId's key contained the old session's
        // entry text. This catches the race deterministically.
        //
        // The fix is `key={sessionId}` on ScratchlistHost in
        // SessionChat.tsx (and the equivalent `keyed=true` path in
        // this fixture). With the key, React unmounts/remounts on
        // session change, so the new mount reads B's storage from
        // scratch and never touches B's key with A's data.
        await page.addInitScript(() => {
            const writes: { key: string; value: string }[] = []
            const orig = window.localStorage.setItem.bind(window.localStorage)
            window.localStorage.setItem = (k: string, v: string) => {
                writes.push({ key: String(k), value: String(v) })
                return orig(k, v)
            }
            ;(window as unknown as { __lsWrites: typeof writes }).__lsWrites = writes
        })

        await page.goto(`/e2e-fixtures/scratchlist-fixture.html?session=leak-A`)
        await expect(page.getByTestId('scratchlist-panel')).toBeVisible()
        await expandPanel(page)
        await addEntry(page, 'A-only entry')
        await expect(page.getByText('A-only entry')).toBeVisible()

        // Clear the recorded writes from the setup phase so the
        // assertion below only inspects writes that happened DURING
        // the session switch.
        await page.evaluate(() => {
            ;(window as unknown as { __lsWrites: { key: string; value: string }[] }).__lsWrites.length = 0
        })

        // Switch sessionId in-place WITHOUT reloading the parent.
        await page.evaluate(() => window.__scratchlistE2E!.setSessionId('leak-B'))

        // Wait for the dust to settle (effects + re-render).
        await expect(page.getByRole('button', { name: 'Scratchlist' })).toHaveAttribute(
            'aria-expanded',
            'false'
        )

        // No write to leak-B's storage key should contain A's entry.
        const writes = await page.evaluate(
            () => (window as unknown as { __lsWrites: { key: string; value: string }[] }).__lsWrites.slice()
        )
        const leakBKey = 'hapi.scratchlist.v1.leak-B'
        const corruptingWrite = writes.find(
            (w) => w.key === leakBKey && w.value.includes('A-only entry')
        )
        expect(corruptingWrite, `found corrupting write to ${leakBKey}: ${JSON.stringify(corruptingWrite)}`).toBeUndefined()

        // Final state assertions: leak-B is empty, leak-A retains its
        // entry on round-trip back.
        await expandPanel(page)
        await expect(page.getByText('empty', { exact: true })).toBeVisible()
        await expect(page.getByText('A-only entry')).toHaveCount(0)

        await page.evaluate(() => window.__scratchlistE2E!.setSessionId('leak-A'))
        await expandPanel(page)
        await expect(page.getByText('A-only entry')).toBeVisible()
    })

    test('per-session isolation: full reload across sessions does not leak entries', async ({ page }) => {
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
