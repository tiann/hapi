import { expect, test } from '@playwright/test'

const fixture = '/e2e-fixtures/settings-fixture.html'

test.describe('settings responsive layout', () => {
    test('mobile drills from the category hub into a full-width detail page', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 })
        await page.goto(fixture)

        await expect(page.getByText('Choose a category to adjust HAPI to your workflow.')).toBeVisible()
        await expect(page.getByRole('button', { name: /Display/ })).toBeVisible()
        await expect(page.locator('aside')).toBeHidden()

        await page.getByRole('button', { name: /Display/ }).click()

        await expect(page.locator('header').getByRole('heading', { name: 'Display' })).toBeVisible()
        await expect(page.getByText('Appearance, typography, and session list preferences.')).toBeVisible()
        await expect(page.getByText('Choose a category to adjust HAPI to your workflow.')).toBeHidden()
        await expect(page.getByRole('listbox')).toHaveCount(0)
    })

    test('desktop keeps navigation visible and renders Display as the default detail', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.goto(fixture)

        const desktopNav = page.locator('aside nav')
        await expect(desktopNav).toBeVisible()
        await expect(desktopNav.getByRole('button', { name: 'Display' })).toHaveAttribute('aria-current', 'page')
        await expect(page.getByRole('heading', { name: 'Display' })).toBeVisible()
        await expect(page.getByText('Appearance, typography, and session list preferences.')).toBeVisible()
        await expect(page.getByText('Choose a category to adjust HAPI to your workflow.')).toBeHidden()

        await page.setViewportSize({ width: 390, height: 844 })
        await expect(page.getByText('Choose a category to adjust HAPI to your workflow.')).toBeVisible()
        await expect(page.locator('aside')).toBeHidden()
    })
})
