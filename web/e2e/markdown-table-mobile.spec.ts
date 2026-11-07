import { devices, expect, test } from '@playwright/test'

test.use({ ...devices['Pixel 7'] })

test('mobile markdown table viewer requests landscape and releases orientation controls', async ({ page }) => {
    await page.goto('/e2e-fixtures/markdown-table-fixture.html')
    await page.evaluate(() => {
        const state = { requestFullscreen: 0, exitFullscreen: 0, locks: [] as string[], unlocks: 0 }
        Object.defineProperty(window, '__hapiTableViewerState', { configurable: true, value: state })
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            value: () => {
                state.requestFullscreen += 1
                return Promise.resolve()
            },
        })
        Object.defineProperty(document, 'exitFullscreen', {
            configurable: true,
            value: () => {
                state.exitFullscreen += 1
                return Promise.resolve()
            },
        })
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: {
                lock: (value: string) => {
                    state.locks.push(value)
                    return Promise.resolve()
                },
                unlock: () => {
                    state.unlocks += 1
                },
            },
        })
    })

    const inlineTable = page.locator('[data-testid="markdown-table-fixture"] table')
    const inlineActions = page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-actions')
    await expect(inlineActions).not.toBeAttached()
    const readInlineLayout = () => inlineTable.evaluate((table) => ({
        width: Math.round(table.getBoundingClientRect().width),
        columns: Array.from(table.tHead?.rows[0]?.cells ?? []).map((cell) => Math.round(cell.getBoundingClientRect().width)),
    }))
    const layoutBeforeReveal = await readInlineLayout()
    await inlineTable.locator('thead').click()
    await expect(inlineActions).toBeVisible()
    expect(await readInlineLayout()).toEqual(layoutBeforeReveal)
    await expect(inlineActions.getByRole('button')).toHaveCount(3)
    await expect(inlineActions.getByRole('button', { name: 'Copy table as Markdown' })).toBeVisible()
    await inlineActions.getByRole('button', { name: 'Download table' }).click()
    await expect(page.getByRole('menuitem', { name: 'Download PNG' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Download CSV' })).toBeVisible()
    await page.keyboard.press('Escape')
    await inlineTable.locator('thead').click()
    await expect(inlineActions).not.toBeAttached()
    expect(await readInlineLayout()).toEqual(layoutBeforeReveal)
    await inlineTable.locator('thead').click()
    await expect(inlineActions).toBeVisible()
    await page.getByRole('button', { name: 'Open table full screen' }).click()
    const dialog = page.getByRole('dialog', { name: 'Table filename fixture' })
    await expect(dialog).toBeVisible()
    // A real mobile browser can rotate to a landscape CSS viewport. Keep the
    // mobile title unshifted even when its width becomes desktop-sized.
    await page.setViewportSize({ width: 915, height: 412 })
    const wrapButton = dialog.locator('button[data-hapi-table-wrap-toggle="true"]')
    await expect(wrapButton).toBeVisible()
    await expect.poll(() => dialog.locator('[data-hapi-table-viewer-heading="true"]').evaluate((element) => getComputedStyle(element).fontSize)).toBe('18px')
    await expect.poll(() => dialog.locator('[data-hapi-table-viewer-heading="true"]').evaluate((element) => getComputedStyle(element).transform)).toBe('matrix(1, 0, 0, 1, 0, 1)')
    const mobileToolbarMetrics = await dialog.locator('[data-hapi-table-viewer-toolbar="true"]').evaluate((element) => ({
        toolbarHeight: Math.round(element.getBoundingClientRect().height),
        controls: Array.from(element.querySelectorAll('[data-hapi-table-viewer-control="true"]')).map((control) => ({
            height: Math.round(control.getBoundingClientRect().height),
            width: Math.round(control.getBoundingClientRect().width),
            iconHeight: Math.round(control.querySelector('svg')?.getBoundingClientRect().height ?? 0),
            iconWidth: Math.round(control.querySelector('svg')?.getBoundingClientRect().width ?? 0),
        })),
    }))
    expect(mobileToolbarMetrics).toEqual({
        toolbarHeight: 36,
        controls: [
            { height: 36, width: 36, iconHeight: 20, iconWidth: 20 },
            { height: 36, width: 36, iconHeight: 20, iconWidth: 20 },
            { height: 36, width: 36, iconHeight: 20, iconWidth: 20 },
            { height: 36, width: 36, iconHeight: 20, iconWidth: 20 },
        ],
    })
    await expect(wrapButton).toHaveAttribute('aria-pressed', /true|false/)
    await expect(dialog.getByRole('button', { name: 'Copy table as Markdown' })).toBeVisible()
    const downloadButton = dialog.getByRole('button', { name: 'Download table' })
    await expect(downloadButton).toBeVisible()
    const initiallyWrapped = await wrapButton.getAttribute('aria-pressed')
    await wrapButton.click()
    await expect(wrapButton).toHaveAttribute('aria-pressed', initiallyWrapped === 'true' ? 'false' : 'true')
    await expect.poll(() => dialog.locator('[data-hapi-table-viewer-toolbar="true"]').evaluate((element) => {
        const style = getComputedStyle(element)
        return `${style.paddingLeft}:${style.paddingRight}:${style.paddingTop}:${style.paddingBottom}`
    })).toBe('6px:6px:0px:0px')
    await expect.poll(() => dialog.locator('[data-hapi-table-viewer-toolbar="true"]').evaluate((element) => getComputedStyle(element).columnGap)).toBe('4px')
    await expect.poll(() => dialog.locator('[data-hapi-table-viewer-heading="true"]').evaluate((element) => getComputedStyle(element).transform)).toBe('matrix(1, 0, 0, 1, 0, 1)')
    await expect.poll(() => dialog.locator('[data-hapi-table-viewer="true"] thead th').first().evaluate((element) => {
        const thead = element.closest('thead')
        return `${getComputedStyle(thead ?? element).position}:${getComputedStyle(element).position}:${getComputedStyle(element).top}`
    })).toBe('static:sticky:0px')
    await expect.poll(() => page.evaluate(() => {
        const state = (window as Window & { __hapiTableViewerState?: { requestFullscreen: number; locks: string[] } }).__hapiTableViewerState
        return state ? `${state.requestFullscreen}:${state.locks.join(',')}` : ''
    })).toBe('1:landscape')

    await downloadButton.click()
    await expect(page.getByRole('menuitem', { name: 'Download PNG' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Download CSV' })).toBeVisible()
    const imageDownloadPromise = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'Download PNG' }).click()
    const imageDownload = await imageDownloadPromise
    expect(imageDownload.suggestedFilename()).toMatch(/^HAPI Table-Table filename fixture-\d{14}\.png$/)

    const csvDownloadPromise = page.waitForEvent('download')
    await downloadButton.click()
    await page.getByRole('menuitem', { name: 'Download CSV' }).click()
    const csvDownload = await csvDownloadPromise
    expect(csvDownload.suggestedFilename()).toMatch(/^HAPI Table-Table filename fixture-\d{14}\.csv$/)

    await dialog.getByRole('button', { name: 'Close table full screen' }).click()
    await expect.poll(() => page.evaluate(() => {
        const state = (window as Window & { __hapiTableViewerState?: { exitFullscreen: number; unlocks: number } }).__hapiTableViewerState
        return state ? `${state.exitFullscreen}:${state.unlocks}` : ''
    })).toBe('1:1')
})

test('mobile markdown table viewer detects a phone that starts in landscape', async ({ page }) => {
    await page.setViewportSize({ width: 915, height: 412 })
    await page.goto('/e2e-fixtures/markdown-table-fixture.html')
    await expect(page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-actions')).not.toBeAttached()
    await page.locator('[data-testid="markdown-table-fixture"] table thead').click()
    await expect(page.getByRole('button', { name: 'Open table full screen' })).toBeVisible()
    await page.evaluate(() => {
        const state = { requestFullscreen: 0, locks: [] as string[] }
        Object.defineProperty(window, '__hapiTableViewerState', { configurable: true, value: state })
        Object.defineProperty(document.documentElement, 'requestFullscreen', {
            configurable: true,
            value: () => {
                state.requestFullscreen += 1
                return Promise.resolve()
            },
        })
        Object.defineProperty(window.screen, 'orientation', {
            configurable: true,
            value: {
                lock: (value: string) => {
                    state.locks.push(value)
                    return Promise.resolve()
                },
                unlock: () => {},
            },
        })
    })

    await page.getByRole('button', { name: 'Open table full screen' }).click()
    await expect(page.getByRole('dialog', { name: 'Table filename fixture' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => {
        const state = (window as Window & { __hapiTableViewerState?: { requestFullscreen: number; locks: string[] } }).__hapiTableViewerState
        return state ? `${state.requestFullscreen}:${state.locks.join(',')}` : ''
    })).toBe('1:landscape')
})

test('mobile wrapped headers keep controls horizontal with their backdrop', async ({ page }) => {
    await page.goto('/e2e-fixtures/markdown-table-fixture.html?multiline-header')

    const table = page.locator('[data-testid="markdown-table-fixture"] table')
    const actions = page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-actions')
    await expect(actions).not.toBeAttached()
    await table.locator('thead').click()
    await expect(actions).toHaveAttribute('data-hapi-table-actions-layout', 'horizontal')

    const controls = await actions.locator('[data-hapi-table-action]').evaluateAll((elements) => elements
        .map((element) => {
            const button = element.matches('button') ? element : element.querySelector('button')
            const style = button ? getComputedStyle(button) : null
            return {
                action: element.getAttribute('data-hapi-table-action'),
                top: Math.round(element.getBoundingClientRect().top),
                backgroundColor: style?.backgroundColor,
                backdropFilter: style?.backdropFilter,
                borderWidth: style?.borderTopWidth,
                transitionProperty: style?.transitionProperty,
            }
        })
        .sort((left, right) => left.top - right.top))

    expect(controls.map((control) => control.action)).toEqual(['copy', 'download', 'fullscreen'])
    expect(controls.every((control) => control.backgroundColor !== 'rgba(0, 0, 0, 0)' && control.backdropFilter !== 'none')).toBe(true)
    expect(controls.every((control) => control.borderWidth === '0px')).toBe(true)
    expect(controls.every((control) => !(control.transitionProperty ?? '').includes('background'))).toBe(true)
    await expect(actions.getByRole('button', { name: 'Copy table as Markdown' })).toBeVisible()
})

test('mobile controls stay transparent when no header text is underneath', async ({ page }) => {
    await page.goto('/e2e-fixtures/markdown-table-fixture.html?empty-action-area')

    const table = page.locator('[data-testid="markdown-table-fixture"] table')
    const actions = page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-actions')
    await table.locator('thead').click()
    await expect(actions).toHaveAttribute('data-hapi-table-actions-layout', 'horizontal')

    const controls = await actions.locator('[data-hapi-table-action]').evaluateAll((elements) => elements.map((element) => {
        const button = element.matches('button') ? element : element.querySelector('button')
        const style = button ? getComputedStyle(button) : null
        return {
            surface: button?.getAttribute('data-hapi-table-action-surface'),
            backgroundColor: style?.backgroundColor,
            backdropFilter: style?.backdropFilter,
        }
    }))

    expect(controls).toHaveLength(3)
    expect(controls.every((control) => control.surface === null
        && /rgba\(0, 0, 0, 0\)|transparent/.test(control.backgroundColor ?? '')
        && control.backdropFilter === 'none')).toBe(true)
})

test('refreshes control backdrops when the table scrolls horizontally', async ({ page }) => {
    await page.goto('/e2e-fixtures/markdown-table-fixture.html')

    const table = page.locator('[data-testid="markdown-table-fixture"] table')
    const actions = page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-actions')
    const scrollContainer = table.locator('..')
    await table.locator('thead').click()
    await expect.poll(() => scrollContainer.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0)

    const readSurfaceState = () => page.evaluate(() => {
        const table = document.querySelector<HTMLTableElement>('[data-testid="markdown-table-fixture"] table')
        const actions = document.querySelector<HTMLElement>('[data-testid="markdown-table-fixture"] .aui-md-table-actions')
        const scrollContainer = table?.parentElement
        if (!table || !actions || !scrollContainer) throw new Error('Table surface geometry is incomplete')

        const textRects = Array.from(table.tHead?.rows ?? []).flatMap((row) => Array.from(row.cells)).flatMap((cell) => {
            const range = document.createRange()
            range.selectNodeContents(cell)
            return Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0)
        })
        const overlaps = (left: DOMRect, right: DOMRect) => left.left < right.right
            && left.right > right.left
            && left.top < right.bottom
            && left.bottom > right.top
        const state = Array.from(actions.querySelectorAll<HTMLElement>('[data-hapi-table-action]')).map((element) => {
            const button = element.matches('button') ? element : element.querySelector('button')
            const actionRect = element.getBoundingClientRect()
            return {
                action: element.dataset.hapiTableAction,
                actual: button?.dataset.hapiTableActionSurface === 'true',
                expected: textRects.some((textRect) => overlaps(textRect, actionRect)),
            }
        })
        return { scrollLeft: scrollContainer.scrollLeft, state }
    })

    await scrollContainer.evaluate((element) => { element.scrollLeft = element.scrollWidth })
    await expect.poll(async () => {
        const snapshot = await readSurfaceState()
        return snapshot.scrollLeft > 0 && snapshot.state.every((item) => item.actual === item.expected)
    }).toBe(true)

    const snapshot = await readSurfaceState()
    expect(snapshot.scrollLeft).toBeGreaterThan(0)
    expect(snapshot.state.every((item) => item.actual === item.expected)).toBe(true)
})
