import { expect, test } from '@playwright/test'

const fixture = '/e2e-fixtures/settings-fixture.html'

for (const fixtureCase of [
    { locale: 'ja', projectOrder: 'プロジェクトの並び順', recent: '最近のユーザー入力', layout: '進行中セッションの固定レイアウト', combined: '統合' },
    { locale: 'ru', projectOrder: 'Порядок проектов', recent: 'Последний ввод пользователя', layout: 'Макет закрепления сессий в работе', combined: 'Объединённо' },
]) {
    test(`localizes project and pinning settings in ${fixtureCase.locale}`, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 })
        await page.addInitScript(locale => window.localStorage.setItem('hapi-lang', locale), fixtureCase.locale)
        await page.goto(fixture)
        await expect(page.getByRole('radiogroup', { name: fixtureCase.projectOrder })).toBeVisible()
        await expect(page.getByRole('radio', { name: fixtureCase.recent })).toBeVisible()
        await expect(page.getByRole('radiogroup', { name: fixtureCase.layout })).toBeVisible()
        await expect(page.getByRole('radio', { name: fixtureCase.combined })).toBeVisible()
        await page.getByRole('radiogroup', { name: fixtureCase.projectOrder }).scrollIntoViewIfNeeded()
        const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
        if (screenshots) await page.screenshot({ path: `${screenshots}/settings-display-${fixtureCase.locale}.png` })
    })
}

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

    test('desktop keeps navigation visible and renders Display as the default detail', async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 1280, height: 800 })
        await page.goto(fixture)

        const desktopNav = page.locator('aside nav')
        await expect(desktopNav).toBeVisible()
        await expect(desktopNav.getByRole('button', { name: 'Display' })).toHaveAttribute('aria-current', 'page')
        await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
        await expect(page.getByText('Appearance, typography, and session list preferences.')).toBeVisible()
        await expect(page.getByText('Choose a category to adjust HAPI to your workflow.')).toBeHidden()

        const projectOrder = page.getByRole('radiogroup', { name: 'Project order' })
        await expect(projectOrder).toBeVisible()
        await expect(projectOrder.getByRole('radio', { name: 'Recent user input' })).toHaveAttribute('aria-checked', 'true')
        await expect(projectOrder.getByRole('radio', { name: 'Most sessions' })).toHaveAttribute('aria-checked', 'false')
        await page.screenshot({ path: testInfo.outputPath('settings-project-order.png'), fullPage: true })
        await projectOrder.getByRole('radio', { name: 'Most sessions' }).click()
        await expect(projectOrder.getByRole('radio', { name: 'Most sessions' })).toHaveAttribute('aria-checked', 'true')

        const appBadgeToggle = page.getByRole('checkbox', { name: 'Taskbar unread badge' })
        await expect(appBadgeToggle).not.toBeChecked()
        await appBadgeToggle.locator('xpath=..').click()
        await expect(appBadgeToggle).toBeChecked()
        await page.reload()
        await expect(page.getByRole('checkbox', { name: 'Taskbar unread badge' })).toBeChecked()

        await page.setViewportSize({ width: 390, height: 844 })
        await expect(page.getByText('Choose a category to adjust HAPI to your workflow.')).toBeVisible()
        await expect(page.locator('aside')).toBeHidden()
    })
})
