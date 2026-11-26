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
        await expect(page.getByRole('button', { name: /Detached running job/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Working task/ })).not.toContainText('/work/hapi')

        const divider = page.getByRole('separator', { name: 'Archived project sessions' })
        const projectHeaders = page.getByTitle('/work/hapi', { exact: true })
        await expect(projectHeaders).toHaveCount(2)
        const activeHeader = projectHeaders.nth(0)
        const archivedHeader = projectHeaders.nth(1)
        const activePanel = activeHeader.locator('xpath=following-sibling::*[1]')
        await expect(divider).toHaveClass(/border-t/)
        const jobBox = (await page.getByRole('button', { name: /Detached running job/ }).boundingBox())!
        expect(jobBox.y).toBeLessThan((await divider.boundingBox())!.y)
        await expect(activeHeader).toBeVisible()
        await expect(archivedHeader).toBeVisible()
        await expect(activePanel.getByRole('button', { name: /Expand/ })).toHaveCount(0)

        await expect(page.getByRole('button', { name: 'Expand 1' })).toBeVisible()
        await expect(page.getByRole('button', { name: /Archived task 1/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Archived task 3/ })).toHaveCount(0)

        await page.screenshot({ path: testInfo.outputPath('combined-session-layout.png'), fullPage: true })
        const jobsHeader = page.getByTitle('/work/jobs', { exact: true })
        await jobsHeader.click()
        await expect(page.getByRole('button', { name: /Detached running job/ })).toBeHidden()
        await jobsHeader.click()
        await expect(page.getByRole('button', { name: /Detached running job/ })).toBeVisible()
    })

    test('keeps a rename draft when a session disconnects and moves to the archived group', async ({ page }) => {
        const divider = page.getByRole('separator', { name: 'Archived project sessions', includeHidden: true })
        const row = page.locator('[data-session-row-id="session-quiet"]')
        expect((await row.boundingBox())!.y).toBeLessThan((await divider.boundingBox())!.y)
        await row.getByRole('button', { name: /Quiet task/ }).click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
        const dialog = page.getByRole('dialog', { name: 'Rename Session' })
        const title = dialog.getByPlaceholder('Session name')
        await title.fill('Keep this draft')
        await page.evaluate(() => window.dispatchEvent(new Event('fixture:disconnect-quiet-session')))
        await expect.poll(async () => (await row.boundingBox())!.y).toBeGreaterThan((await divider.boundingBox())!.y)
        await expect(dialog).toBeVisible()
        await expect(title).toHaveValue('Keep this draft')
        await expect(title).toBeFocused()
        if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
            await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/rename-draft-after-disconnect.png` })
        }
    })

    test('keeps working sessions pinned and quiet sessions in project folders in detailed mode', async ({ page }) => {
        await page.goto(`${fixtureUrl}?mode=detailed`)

        await expect(page.getByTitle('In progress')).toBeVisible()
        await expect(page.getByTitle('Active sessions')).toHaveCount(0)
        await expect(page.getByText(/Running \(1\)/)).toBeVisible()
        await expect(page.getByText(/pending \(1\)/)).toBeVisible()
        await expect(page.getByTitle('/work/hapi', { exact: true })).toBeVisible()
        await expect(page.getByRole('separator', { name: 'Archived project sessions' })).toHaveCount(0)
    })
})

for (const [locale, label, detailed, combined, archived] of [
    ['zh-CN', '置顶进行中会话布局', '详细', '合并', '已归档项目会话'],
    ['ja', '進行中のセッションの表示形式', '詳細', '統合', 'アーカイブ済みのプロジェクトセッション'],
    ['ru', 'Расположение сессий в работе', 'Подробный', 'Объединённый', 'Архивные сессии проектов'],
]) {
    test(`localizes the layout controls and archived separator for ${locale}`, async ({ page }) => {
        await page.addInitScript((language) => {
            localStorage.setItem('hapi-lang', language)
            localStorage.setItem('hapi-pin-in-progress-sessions', 'true')
            localStorage.setItem('hapi-pin-in-progress-sessions-mode', 'combined')
        }, locale)
        await page.goto(`${fixtureUrl}?view=settings`)
        const choices = page.getByRole('radiogroup', { name: label })
        await expect(choices.getByRole('radio', { name: detailed })).toBeVisible()
        await expect(choices.getByRole('radio', { name: combined })).toBeChecked()
        if (locale === 'zh-CN' && process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
            await page.getByTestId('pin-in-progress-settings').screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/session-layout-settings-zh.png` })
        }
        await page.goto(fixtureUrl)
        await expect(page.getByRole('separator', { name: archived })).toBeVisible()
    })
}
