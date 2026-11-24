import { chromium, expect, test, type Page } from '@playwright/test'
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

for (const width of [393, 320]) {
    test(`optional machine filter works without overlapping toolbar controls at ${width}px`, async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem('hapi-show-mobile-machine-filter', 'true'))
        await open(page, width)
        const machineButton = page.getByRole('button', { name: 'Filter sessions by machine', exact: true })
        await expect(machineButton).toBeVisible()
        const actions = page.getByTestId('session-list-header-actions')
        const buttons = actions.locator('button:visible:not([inert] *)')
        const boxes = (await buttons.evaluateAll(elements => elements.map(element => {
            const rect = element.getBoundingClientRect()
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        })))
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i]!
                const b = boxes[j]!
                expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)
            }
        }
        await machineButton.click()
        const machineMenu = page.getByRole('menu', { name: 'Filter sessions by machine' })
        await expect(machineMenu).toBeInViewport({ ratio: 1 })
        await machineMenu.getByRole('menuitemradio', { name: /^Server \(1\)$/ }).click()
        await expect(page.getByRole('button', { name: /Server draft/ })).toBeVisible()
        await expect(page.getByRole('button', { name: /Reviewed draft/ })).toHaveCount(0)
        await page.getByRole('button', { name: 'Sort and filter', exact: true }).click()
        await expect(page.getByRole('menu', { name: 'Sort and filter' }).getByRole('menuitemradio', { name: /^Server \(1\)$/ })).toHaveAttribute('aria-checked', 'true')
    })
}

test('optional mobile machine filter does not occupy the desktop toolbar', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi-show-mobile-machine-filter', 'true'))
    await open(page, 1280)
    await expect(page.getByRole('button', { name: 'Filter sessions by machine', exact: true })).toHaveCount(0)
    await expect(page.getByTestId('session-toolbar-slot-machine-filter')).toHaveCount(0)
})

test('keeps Sort and filter on the toolbar before the shortcut with a long search', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('hapi-show-mobile-machine-filter', 'true')
        localStorage.setItem('hapi-font-scale', '1.1')
    })
    await open(page, 320)
    await page.getByRole('button', { name: /Search sessions/ }).click()
    const search = page.getByPlaceholder(/Search title/)
    await search.fill('a very long collapsed session search query')
    await search.blur()
    await expect(page.getByTestId('session-list-header-actions').getByRole('button', { name: 'Sort and filter' })).toBeVisible()
})

test('keeps Sort and filter accessible with the shortcut at large font size', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('hapi-font-scale', '1.3')
    })
    await page.addInitScript(() => localStorage.setItem('hapi.fue.v1.session-list-view-menu', '1'))
    await page.setViewportSize({ width: 334, height: 844 })
    await page.goto('/e2e-fixtures/session-list-filter-fixture.html?lang=en&allRead')
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-font-scale').trim())).toBe('1.3')
    const searchAndCollapse = async () => {
        await page.getByRole('button', { name: /Search sessions/ }).click()
        const search = page.getByPlaceholder(/Search title/)
        await search.fill('a very long collapsed session search query')
        await search.blur()
    }
    await searchAndCollapse()
    expect((await page.getByTestId('session-list-search').boundingBox())!.width).toBeGreaterThan(150)
    await page.getByRole('button', { name: 'More session list actions', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sort and filter', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.evaluate(() => localStorage.setItem('hapi-show-mobile-machine-filter', 'true'))
    await page.reload()
    await searchAndCollapse()
    await expect(page.getByRole('button', { name: 'Clear search' })).toBeVisible()
    const queryText = page.getByTestId('session-list-search').locator('[data-search-query-text]')
    expect(await queryText.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(40)
    await page.getByRole('button', { name: 'More session list actions', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Sort and filter', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Filter sessions by machine', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 364, height: 844 })
    await expect(page.getByTestId('session-list-header-actions').getByRole('button', { name: 'Sort and filter' })).toBeVisible()
})

test('keeps collapsed query text when the mobile toolbar has room', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi-show-mobile-machine-filter', 'true'))
    await open(page, 440)
    await page.getByRole('button', { name: /Search sessions/ }).click()
    const search = page.getByPlaceholder(/Search title/)
    await search.fill('a very long collapsed session search query')
    await search.blur()
    const queryText = page.getByTestId('session-list-search').locator('span.truncate')
    await expect(queryText).toHaveText('a very long collapsed session search query')
    expect(await queryText.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(20)
})

test('dismisses the machine filter inside More one layer at a time', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('hapi-show-mobile-machine-filter', 'true')
        localStorage.setItem('hapi-font-scale', '1.3')
    })
    await open(page, 320)
    await page.getByRole('button', { name: /Search sessions/ }).click()
    await page.getByPlaceholder(/Search title/).fill('a very long collapsed session search query')
    await page.getByPlaceholder(/Search title/).blur()
    const more = page.getByRole('button', { name: 'More session list actions', exact: true })
    await more.click()
    const machineTrigger = page.getByRole('button', { name: 'Filter sessions by machine', exact: true })
    await machineTrigger.click()
    const machineMenu = page.getByRole('menu', { name: 'Filter sessions by machine', exact: true })
    await expect(machineMenu.getByRole('menuitemradio').first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(machineMenu.getByRole('menuitemradio').nth(1)).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(machineMenu).toHaveCount(0)
    await expect(machineTrigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(machineTrigger).toHaveCount(0)
    await expect(more).toBeFocused()

    // Selecting a machine and clicking the submenu's backdrop also return to
    // More, where the other actions remain available.
    await more.click()
    await machineTrigger.click()
    await machineMenu.getByRole('menuitemradio', { name: /^Server \(1\)$/ }).click()
    await expect(machineMenu).toHaveCount(0)
    await expect(machineTrigger).toBeFocused()
    await machineTrigger.click()
    await page.getByRole('button', { name: 'Close', exact: true }).click({ position: { x: 3, y: 3 } })
    await expect(machineMenu).toHaveCount(0)
    await expect(machineTrigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(more).toBeFocused()

    // The combined filter uses the same custom-menu dismissal contract.
    await more.click()
    const sortTrigger = page.getByRole('button', { name: 'Sort and filter', exact: true })
    await sortTrigger.click()
    await expect(page.getByRole('menu', { name: 'Sort and filter', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sortTrigger).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(more).toBeFocused()
})

for (const scale of [1, 1.3]) {
    for (const allRead of [false, true]) {
        for (const browse of [false, true]) {
            test(`keeps query and controls usable across widths (scale ${scale}, allRead ${allRead}, browse ${browse})`, async ({ page }) => {
                test.setTimeout(60_000)
                await page.addInitScript(({ scale }) => {
                    localStorage.setItem('hapi-show-mobile-machine-filter', 'true')
                    localStorage.setItem('hapi-font-scale', String(scale))
                    localStorage.setItem('hapi.fue.v1.session-list-view-menu', '1')
                }, { scale })
                await page.setViewportSize({ width: 440, height: 844 })
                await page.goto('/e2e-fixtures/session-list-filter-fixture.html?lang=en' + (allRead ? '&allRead' : '') + (browse ? '&browse' : ''))
                await page.getByRole('button', { name: /Search sessions/ }).click()
                await page.getByPlaceholder(/Search title/).fill('a very long collapsed session search query')
                await page.getByPlaceholder(/Search title/).blur()

                // Sweep both directions so stale ResizeObserver measurements
                // cannot pass by testing only fresh mounts at selected widths.
                const widths = Array.from({ length: 61 }, (_, index) => 320 + index * 2)
                for (const width of [...widths, ...widths.reverse()]) {
                    await page.setViewportSize({ width, height: 844 })
                    // Let the row, search and actions ResizeObservers settle.
                    await page.evaluate(async () => {
                        for (let frame = 0; frame < 4; frame++) {
                            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
                        }
                    })
                    const layout = await page.evaluate(() => {
                        const row = document.querySelector<HTMLElement>('[data-testid="session-list-header-row"]')!
                        const search = row.querySelector<HTMLElement>('[data-testid="session-list-search"]')!
                        const query = search.querySelector<HTMLElement>('[data-search-query-text]')!
                        const controls = [
                            ...search.querySelectorAll<HTMLElement>('button'),
                            ...row.querySelectorAll<HTMLElement>('[data-testid="session-list-header-actions"] button:not([inert] *)'),
                        ].filter(element => element.getBoundingClientRect().width > 0)
                        const boxes = controls.map(element => {
                            const box = element.getBoundingClientRect()
                            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
                        })
                        return {
                            queryWidth: query.getBoundingClientRect().width,
                            queryFontSize: Number.parseFloat(getComputedStyle(query).fontSize),
                            right: Math.min(row.getBoundingClientRect().right, innerWidth),
                            boxes,
                        }
                    })
                    expect(layout.queryWidth, `query at ${width}px`).toBeGreaterThanOrEqual(layout.queryFontSize * 3 - 1)
                    for (let index = 0; index < layout.boxes.length; index++) {
                        const box = layout.boxes[index]!
                        expect(box.right, `control at ${width}px`).toBeLessThanOrEqual(layout.right + 1)
                        const next = layout.boxes[index + 1]
                        if (next) expect(box.right, `overlap at ${width}px`).toBeLessThanOrEqual(next.left + 0.5)
                    }
                }
                // A short query uses its natural width; it must not be clipped
                // to make room for an extra action either.
                await page.getByRole('button', { name: /Search sessions/ }).click()
                await page.getByPlaceholder(/Search title/).fill('hi')
                await page.getByPlaceholder(/Search title/).blur()
                const shortQuery = page.getByTestId('session-list-search').locator('[data-search-query-text]')
                expect(await shortQuery.evaluate(element => element.getBoundingClientRect().width + 1 >= element.scrollWidth)).toBe(true)
                await page.getByRole('button', { name: 'Clear search' }).click()
                await expect(shortQuery).toHaveCount(0)
                await expect(page.getByTestId('session-list-header-actions').getByRole('button', { name: 'Sort and filter', exact: true })).toBeVisible()
            })
        }
    }
}

test('uses the same mobile breakpoint as the machine chips with a larger browser font', async ({ baseURL }) => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--blink-settings=defaultFontSize=20'] })
    try {
        const page = await browser.newPage({ baseURL })
        await page.addInitScript(() => localStorage.setItem('hapi-show-mobile-machine-filter', 'true'))
        await open(page, 820)
        expect(await page.evaluate(() => matchMedia('(width < 48rem)').matches)).toBe(true)
        await expect(page.getByRole('button', { name: 'Filter sessions by machine', exact: true })).toBeVisible()
    } finally {
        await browser.close()
    }
})

test('keeps More usable at 320px with large browser and HAPI fonts', async ({ baseURL }) => {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--blink-settings=defaultFontSize=24'] })
    try {
        const page = await browser.newPage({ baseURL, viewport: { width: 320, height: 568 } })
        await page.addInitScript(() => {
            localStorage.setItem('hapi-show-mobile-machine-filter', 'true')
            localStorage.setItem('hapi-font-scale', '1.3')
            localStorage.setItem('hapi.fue.v1.session-list-view-menu', '1')
        })
        await page.goto('/e2e-fixtures/session-list-filter-fixture.html?lang=en&allRead')
        await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--app-font-scale').trim())).toBe('1.3')
        await page.getByRole('button', { name: /Search sessions/ }).click()
        await page.getByPlaceholder(/Search title/).fill('a very long collapsed session search query')
        await page.getByPlaceholder(/Search title/).blur()
        expect(await page.getByTestId('session-list-search').locator('[data-search-query-text]').evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(10)
        const more = page.getByRole('button', { name: 'More session list actions', exact: true })
        await expect(more).toBeVisible()
        expect((await more.boundingBox())!.x + (await more.boundingBox())!.width).toBeLessThanOrEqual(320)
        await more.click()
        const sortFilter = page.getByRole('button', { name: 'Sort and filter', exact: true })
        await expect(sortFilter).toBeVisible()
        await sortFilter.click()
        await expect(page.getByRole('menu', { name: 'Sort and filter' })).toBeVisible()
    } finally {
        await browser.close()
    }
})
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
