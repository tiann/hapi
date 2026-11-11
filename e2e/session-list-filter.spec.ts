import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

test.use({ serviceWorkers: 'block' })
async function screenshot(page: Page, name: string) {
    if (!process.env.HAPI_TASK_RUNTIME) return
    const directory = join(process.env.HAPI_TASK_RUNTIME, 'screenshots')
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, name + '.png') })
}
async function open(page: Page, width: number, lang = 'en') {
    await page.addInitScript(() => localStorage.setItem('hapi.fue.v1.session-list-view-menu', '1'))
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 })
    await page.goto('/e2e-fixtures/session-list-filter-fixture.html?lang=' + lang)
}
for (const width of [1280, 393, 320]) {
    test(`combines upstream and added filters, resets all conditions at ${width}px`, async ({ page }) => {
        await open(page, width)
        await expect(page.getByRole('button', { name: 'Sort and filter', exact: true })).toHaveCount(1)
        await expect(page.getByRole('button', { name: 'Filter sessions', exact: true })).toHaveCount(0)
        await page.getByRole('button', { name: 'Sort and filter', exact: true }).click()
        const menu = page.getByRole('menu', { name: 'Sort and filter' })
        await expect(menu).toBeInViewport({ ratio: 1 })
        await page.getByRole('menuitemcheckbox', { name: 'Unread only', exact: true }).click()
        await page.getByRole('menuitemcheckbox', { name: 'With drafts only', exact: true }).click()
        await page.getByRole('menuitemradio', { name: 'Active only', exact: true }).click()
        await page.getByRole('menuitemradio', { name: /^Mint \(\d+\)$/ }).click()
        await page.getByRole('menuitem', { name: 'Updated date', exact: true }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeInViewport({ ratio: 1 })
        const dialogBox = (await dialog.boundingBox())!
        const panelBox = (await page.locator('main').boundingBox())!
        expect(Math.abs(dialogBox.x + dialogBox.width / 2 - (panelBox.x + panelBox.width / 2))).toBeLessThanOrEqual(1)
        await screenshot(page, `filter-${width}-date-picker`)
        await dialog.getByRole('button').filter({ hasText: /^9$/ }).click()
        await dialog.getByRole('button').filter({ hasText: /^9$/ }).click()
        await expect(dialog).toHaveCount(0)
        await expect(page.getByRole('button', { name: /HAPI filter integration/ })).toBeVisible()
        for (const name of ['Reviewed draft', 'Unread without draft', 'Archived draft', 'Server draft', 'Older draft']) {
            await expect(page.getByRole('button', { name: new RegExp(name) })).toHaveCount(0)
        }
        await screenshot(page, `filter-${width}-combined`)
        await menu.getByRole('menuitem', { name: 'Reset to default' }).click()
        await expect(menu.getByRole('menuitemcheckbox', { name: 'Unread only' })).toHaveAttribute('aria-checked', 'false')
        await expect(menu.getByRole('menuitemcheckbox', { name: 'With drafts only' })).toHaveAttribute('aria-checked', 'false')
        await expect(menu.getByRole('menuitemradio', { name: 'All sessions' })).toHaveAttribute('aria-checked', 'true')
        await expect(menu.getByRole('menuitemradio', { name: 'All (6)' })).toHaveAttribute('aria-checked', 'true')
        await page.keyboard.press('Escape')
        await expect(page.getByRole('button', { name: /Reviewed draft/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Older draft/ })).toBeVisible()
    })
}
test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 10, 9, 15))
})
test('Chinese mobile menu and keyboard calendar return focus to the date row', async ({ page }) => {
    await open(page, 393, 'zh-CN')
    await page.getByRole('button', { name: '排序与筛选', exact: true }).click()
    const dateRow = page.getByRole('menuitem', { name: '日期', exact: true })
    const dateText = (await dateRow.getByText('日期', { exact: true }).boundingBox())!
    const chevron = (await dateRow.locator('svg[aria-hidden="true"]').boundingBox())!
    expect(chevron.x - dateText.x - dateText.width).toBeCloseTo(4, 0)
    expect(Math.abs(chevron.y + chevron.height / 2 - dateText.y - dateText.height / 2)).toBeLessThanOrEqual(0.5)
    if (process.env.HAPI_TASK_RUNTIME) {
        await mkdir(join(process.env.HAPI_TASK_RUNTIME, 'screenshots'), { recursive: true })
        await dateRow.screenshot({ path: join(process.env.HAPI_TASK_RUNTIME, 'screenshots', 'date-row-inline-chevron.png') })
    }
    await screenshot(page, 'filter-mobile-zh-menu')
    await page.getByRole('menuitem', { name: '日期', exact: true }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await screenshot(page, 'filter-mobile-zh-calendar')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: '日期', exact: true })).toBeFocused()
    await expect(page.getByRole('menu')).toBeVisible()
})

test('preserves the selected session outside the date range and shows Chinese combined conditions', async ({ page }) => {
    await open(page, 393, 'zh-CN')
    await page.getByRole('button', { name: /Older draft/ }).click()
    await page.getByRole('button', { name: '排序与筛选', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: '未读', exact: true }).click()
    await page.getByRole('menuitemcheckbox', { name: '草稿', exact: true }).click()
    await page.getByRole('menuitemradio', { name: '活跃', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^Mint \(\d+\)$/ }).click()
    await page.getByRole('menuitem', { name: '日期', exact: true }).click()
    const calendar = page.getByRole('dialog')
    await calendar.getByRole('button').filter({ hasText: /^9$/ }).click()
    await calendar.getByRole('button').filter({ hasText: /^9$/ }).click()
    await expect(page.getByRole('button', { name: /Older draft/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /HAPI filter integration/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Server draft/ })).toHaveCount(0)
    await screenshot(page, 'filter-mobile-zh-combined')
    await page.getByRole('menuitem', { name: /^日期:/ }).click()
    await expect(page.getByRole('dialog')).toContainText('2026-11-09 – 2026-11-09')
    await screenshot(page, 'compact-selected-date-calendar')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await screenshot(page, 'filter-mobile-zh-results')
})

test('keeps compact date text and centers or clamps the content-sized menu as its trigger and viewport move', async ({ page }) => {
    await open(page, 1280, 'zh-CN')
    const trigger = page.getByRole('button', { name: '排序与筛选', exact: true })
    // Move the real trigger into the middle of a wide viewport, away from clamping.
    await trigger.evaluate(el => { el.parentElement!.style.transform = 'translateX(450px)' })
    await trigger.click()
    const menu = page.getByRole('menu', { name: '排序与筛选' })
    const centered = async () => {
        const buttonBox = (await trigger.boundingBox())!
        const box = (await menu.boundingBox())!
        return Math.abs(box.x + box.width / 2 - buttonBox.x - buttonBox.width / 2)
    }
    await expect.poll(centered).toBeLessThanOrEqual(1)
    const initialWidth = (await menu.boundingBox())!.width
    expect(initialWidth).toBeLessThan(260)
    await screenshot(page, 'ux-desktop-content-width')
    await page.getByRole('menuitem', { name: '日期', exact: true }).click()
    const calendar = page.getByRole('dialog')
    await calendar.getByRole('button').filter({ hasText: /^9$/ }).click()
    await calendar.getByRole('button').filter({ hasText: /^9$/ }).click()
    expect(Math.abs((await menu.boundingBox())!.width - initialWidth)).toBeLessThanOrEqual(1)
    await expect(page.getByRole('menuitem', { name: /^日期:/ })).toHaveText('日期')
    await expect.poll(centered).toBeLessThanOrEqual(1)
    await screenshot(page, 'ux-desktop-selected-date-width')
    // Moving the trigger does not resize it; scrolling must also reposition the menu.
    await trigger.evaluate(el => { el.parentElement!.style.transform = 'translateX(1170px)' })
    await page.evaluate(() => window.dispatchEvent(new Event('scroll')))
    await expect.poll(async () => {
        const box = (await menu.boundingBox())!
        return Math.abs(box.x + box.width - (1280 - 8))
    }).toBeLessThanOrEqual(1)
    await trigger.evaluate(el => { el.parentElement!.style.transform = '' })
    await page.setViewportSize({ width: 320, height: 568 })
    await expect.poll(async () => (await menu.boundingBox())!.x).toBeGreaterThanOrEqual(8)
    await expect(menu).toBeInViewport({ ratio: 1 })
    const box = (await menu.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(312)
    await screenshot(page, 'ux-small-viewport-long-date')
})
