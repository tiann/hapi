import { expect, test } from '@playwright/test'

const fixtureUrl = '/e2e-fixtures/session-list-layout-fixture.html'

test.use({ viewport: { width: 480, height: 800 }, deviceScaleFactor: 1 })

test.describe('session-list pin layout modes', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            window.localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
            window.localStorage.setItem('hapi-pin-in-progress-sessions-mode', 'combined')
            window.localStorage.setItem('hapi-session-preview-limit', '2')
        })
        await page.goto(fixtureUrl)
    })

    test('shows every active session above the archived project preview in combined mode', async ({ page }, testInfo) => {
        await expect(page.getByTitle('Active sessions')).toHaveCount(0)
        await expect(page.getByRole('button', { name: /Working task/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Pending task/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Quiet task/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Working task/ })).not.toContainText('/work/hapi')

        const divider = page.getByRole('separator', { name: 'Archived project sessions' })
        const projectHeaders = page.getByTitle('/work/hapi', { exact: true })
        await expect(projectHeaders).toHaveCount(2)
        const activeHeader = projectHeaders.nth(0)
        const archivedHeader = projectHeaders.nth(1)
        const activePanel = activeHeader.locator('xpath=following-sibling::*[1]')
        await expect(divider).toHaveClass(/border-t/)
        await expect(activeHeader).toBeVisible()
        await expect(archivedHeader).toBeVisible()
        await expect(activePanel.getByRole('button', { name: /Expand/ })).toHaveCount(0)

        await expect(page.getByRole('button', { name: 'Expand 1' })).toBeVisible()
        await expect(page.getByRole('button', { name: /Archived task 1/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Archived task 3/ })).toHaveCount(0)

        await page.screenshot({ path: testInfo.outputPath('combined-session-layout.png'), fullPage: true })
    })

    test('keeps the existing Running and Active sections in detailed mode', async ({ page }) => {
        await page.goto(`${fixtureUrl}?mode=detailed`)

        await expect(page.getByTitle('In progress')).toBeVisible()
        await expect(page.getByTitle('Active sessions')).toBeVisible()
        await expect(page.getByText(/Running \(1\)/)).toBeVisible()
        await expect(page.getByText(/pending \(1\)/)).toBeVisible()
        await expect(page.getByText(/Active \(1\)/)).toBeVisible()
        await expect(page.getByRole('separator', { name: 'Archived project sessions' })).toHaveCount(0)
    })
})
