import { expect, test } from '@playwright/test'

const fixtureUrl = '/e2e-fixtures/session-separate-window-fixture.html'

test.describe('session separate window', () => {
    test('opens a desktop session in a new browsing context with hidden-sidebar state', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 })
        await page.goto(fixtureUrl)

        const action = page.getByRole('menuitem', { name: 'Open in separate window' })
        await expect(action).toBeVisible()
        await expect(action).toHaveAttribute('href', '/sessions/session-123?sidebar=hidden')
        await expect(action).toHaveAttribute('target', '_blank')
        await expect(action).toHaveAttribute('rel', 'noopener noreferrer')

        const popupPromise = page.waitForEvent('popup')
        await action.click()
        const popup = await popupPromise
        await expect(popup).toHaveURL(/\/sessions\/session-123\?sidebar=hidden$/)
        await popup.close()
    })

    test('starts with the full session list hidden and restores it from the edge control', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 })
        await page.goto(`${fixtureUrl}?sidebar=hidden`)

        await expect(page.getByTestId('session-list')).toHaveCount(0)
        const showButton = page.getByRole('button', { name: 'Show session list' })
        await expect(showButton).toBeVisible()

        await showButton.click()

        await expect(page.getByTestId('session-list')).toBeVisible()
        await expect(showButton).toHaveCount(0)
    })

    test('does not expose the desktop-only action on a mobile-width layout', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(fixtureUrl)

        await expect(page.getByRole('menuitem', { name: 'Open in separate window' })).toBeHidden()
    })
})
