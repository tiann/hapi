import { expect, test } from '@playwright/test'

const FIXTURE = '/e2e-fixtures/session-list-blocked-fixture.html'

test.describe('#1717 blocked session-list chrome', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(FIXTURE)
        await page.waitForSelector('[data-testid="blocked-section"]')
    })

    test('surfaces every kind of blocked agent at the top of a 96-session list', async ({ page }) => {
        const section = page.getByTestId('blocked-section')
        await expect(section).toBeVisible()
        // Every blocker class the operator named: self-reported footers
        // (blocked / stalled / decision / review / failed / non-contract
        // "pending"), and agents parked on a prompt (permission / question).
        await expect(section.getByTestId('session-blocked-chip')).toHaveCount(11)
        for (const label of ['Permission', 'Question', 'Decision', 'Review', 'Failed', 'Blocked', 'Stalled']) {
            await expect(section.getByText(label, { exact: true }).first()).toBeVisible()
        }
        // `completed` is a non-contract synonym for done — must stay quiet.
        await expect(section.getByText('Completed', { exact: true })).toHaveCount(0)

        const pill = page.getByTestId('blocked-jump-pill')
        await expect(pill).toBeVisible()
        await expect(pill).toContainText('11')

        await page.screenshot({ path: 'test-results/blocked-1-list-top.png' })
    })

    test('demotes a blocked report older than the loud window', async ({ page }) => {
        await expect(page.locator('[data-session-blocked]')).toHaveCount(11)
        await expect(page.locator('[data-session-blocked="active"]')).toHaveCount(10)
        await expect(page.locator('[data-session-blocked="stale"]')).toHaveCount(1)
    })

    test('the pill stays reachable and travels to a blocked row after scrolling away', async ({ page }) => {
        const scroller = page.locator('.app-scroll-y').first()
        await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
        await expect(page.getByTestId('blocked-section')).not.toBeInViewport()

        const pill = page.getByTestId('blocked-jump-pill')
        // The header does not scroll: the count is still on screen after the
        // blocked rows have left it. This is the off-viewport guarantee.
        await expect(pill).toBeInViewport()
        await expect(pill).toContainText('↑')
        await page.screenshot({ path: 'test-results/blocked-2-scrolled-away.png' })

        await pill.click()
        await expect(page.locator('[data-session-blocked="active"]').first()).toBeInViewport()
        await page.screenshot({ path: 'test-results/blocked-3-after-jump.png' })
    })

    test('still hints off-screen work when the section is collapsed', async ({ page }) => {
        // The collapsible panel animates grid-template-rows to 0fr rather than
        // unmounting, so collapsed rows stay in the DOM. Measuring presence
        // alone would report "all visible" while nothing is on screen.
        const pill = page.getByTestId('blocked-jump-pill')
        await expect(pill).not.toContainText('↑')
        await expect(pill).not.toContainText('↓')

        await page.getByTestId('blocked-section').locator('[role="button"]').first().click()

        await expect(pill).toContainText(/[↑↓↕]/)
    })

    test('the lens toggle narrows the list to blocked work only', async ({ page }) => {
        const toggle = page.getByTestId('blocked-lens-toggle')
        await toggle.click()

        await expect(toggle).toHaveAttribute('aria-pressed', 'true')
        await expect(page.getByTestId('session-blocked-chip')).toHaveCount(11)
        // Every remaining row carries the blocked flag.
        const rows = page.locator('[data-session-id]')
        const blockedRows = page.locator('[data-session-blocked]')
        expect(await rows.count()).toBe(await blockedRows.count())
        // The lens must not leave bare project headers behind for the
        // directories whose only remaining rows floated into the section.
        await expect(page.locator('[data-testid="blocked-section"] ~ * >> text=coding/')).toHaveCount(0)

        await page.screenshot({ path: 'test-results/blocked-4-lens.png' })
    })
})

test.describe('#1717 blocker alerting', () => {
    test('pulses the counter when a new blocker arrives', async ({ page }) => {
        await page.goto(FIXTURE)
        await page.waitForSelector('[data-testid="blocked-section"]')

        const pill = page.getByTestId('blocked-jump-pill')
        // Pre-existing backlog must be quiet on first paint.
        await expect(pill).not.toHaveClass(/animate-blocked-alert/)

        await page.evaluate(() => (window as unknown as { __addBlocker?: () => void }).__addBlocker?.())

        await expect(pill).toHaveClass(/animate-blocked-alert/)
        await page.screenshot({ path: 'test-results/blocked-5-alert-pulse.png' })
    })
})

test.describe('#1717 manual unblock', () => {
    test('right-click a blocked row offers Mark unblocked and demands a reason', async ({ page }) => {
        await page.goto(FIXTURE)
        await page.waitForSelector('[data-testid="blocked-section"]')

        const row = page.locator('[data-session-blocked="active"]').first()
        await row.click({ button: 'right' })

        const item = page.getByTestId('session-action-mark-unblocked')
        await expect(item).toBeVisible()
        await item.click()

        const dialog = page.getByTestId('unblock-reason-dialog')
        await expect(dialog).toBeVisible()
        await page.screenshot({ path: 'test-results/blocked-6-unblock-dialog.png' })

        // Empty reason is refused — the whole point of the prompt.
        await page.getByTestId('unblock-confirm').click()
        await expect(dialog.getByRole('alert')).toBeVisible()
        await expect(dialog).toBeVisible()

        // A preset fills a real, comparable rationale in one tap.
        await dialog.getByText('Handled outside HAPI', { exact: true }).click()
        await page.screenshot({ path: 'test-results/blocked-7-unblock-reason.png' })
    })

    test('an unblocked row is not offered the action', async ({ page }) => {
        await page.goto(FIXTURE)
        await page.waitForSelector('[data-testid="blocked-section"]')

        const clean = page.locator('[data-session-id]:not([data-session-blocked])').first()
        await clean.click({ button: 'right' })

        await expect(page.getByTestId('session-action-mark-unblocked')).toHaveCount(0)
    })
})
