import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test.describe('markdown table actions', () => {
    test('opens a viewport-sized PC viewer and downloads the CSV', async ({ page }) => {
        await page.goto('/e2e-fixtures/markdown-table-fixture.html')

        const inlineTable = page.locator('[data-testid="markdown-table-fixture"] table')
        await expect(inlineTable).toBeVisible()
        await expect(inlineTable.locator('thead')).toBeVisible()

        const tableFrame = page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-frame')
        const actions = tableFrame.locator('.aui-md-table-actions')
        await expect(actions).toBeAttached()
        await expect(actions.getByRole('button')).toHaveCount(1)
        const inlineButtonStyles = await actions.getByRole('button').evaluate((element) => {
            const style = getComputedStyle(element)
            return { backgroundColor: style.backgroundColor, borderWidth: style.borderTopWidth, backdropFilter: style.backdropFilter }
        })
        expect(inlineButtonStyles.backgroundColor).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
        expect(inlineButtonStyles.borderWidth).toBe('0px')
        expect(inlineButtonStyles.backdropFilter).toBe('none')
        await expect.poll(() => actions.evaluate((element) => {
            const style = getComputedStyle(element)
            return `${style.top}:${style.right}`
        })).toBe('3px:3px')
        await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')
        await tableFrame.hover()
        await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')

        await page.getByRole('button', { name: 'Open table full screen' }).click()
        const dialog = page.getByRole('dialog', { name: 'Table filename fixture' })
        await expect(dialog).toBeVisible()

        const viewerHeading = dialog.locator('[data-hapi-table-viewer-heading="true"]')
        await expect(viewerHeading).toHaveText('Table filename fixture')
        await expect.poll(() => viewerHeading.evaluate((element) => getComputedStyle(element).fontSize)).toBe('16px')
        await expect.poll(() => viewerHeading.evaluate((element) => getComputedStyle(element).transform)).toBe('none')
        const toolbar = dialog.locator('[data-hapi-table-viewer-toolbar="true"]')
        await expect.poll(() => toolbar.evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe('0px')
        await expect.poll(() => toolbar.evaluate((element) => `${getComputedStyle(element).paddingLeft}:${getComputedStyle(element).paddingRight}`)).toBe('6px:6px')
        await expect.poll(() => toolbar.evaluate((element) => getComputedStyle(element).columnGap)).toBe('4px')
        await expect.poll(() => toolbar.evaluate((element) => getComputedStyle(element).paddingTop)).toBe('0px')
        await expect.poll(() => toolbar.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('0px')
        const desktopToolbarMetrics = await toolbar.evaluate((element) => ({
            toolbarHeight: Math.round(element.getBoundingClientRect().height),
            controls: Array.from(element.querySelectorAll('[data-hapi-table-viewer-control="true"]')).map((control) => ({
                height: Math.round(control.getBoundingClientRect().height),
                width: Math.round(control.getBoundingClientRect().width),
                iconHeight: Math.round(control.querySelector('svg')?.getBoundingClientRect().height ?? 0),
                iconWidth: Math.round(control.querySelector('svg')?.getBoundingClientRect().width ?? 0),
            })),
        }))
        expect(desktopToolbarMetrics).toEqual({
            toolbarHeight: 32,
            controls: [
                { height: 32, width: 32, iconHeight: 18, iconWidth: 18 },
                { height: 32, width: 32, iconHeight: 18, iconWidth: 18 },
                { height: 32, width: 32, iconHeight: 18, iconWidth: 18 },
                { height: 32, width: 32, iconHeight: 18, iconWidth: 18 },
            ],
        })
        const toolbarEdges = await toolbar.evaluate((element) => {
            const buttons = element.querySelectorAll('button')
            const first = buttons[0]?.getBoundingClientRect()
            const last = buttons[buttons.length - 1]?.getBoundingClientRect()
            const toolbarRect = element.getBoundingClientRect()
            return {
                leftGap: Math.round((first?.left ?? 0) - toolbarRect.left),
                rightGap: Math.round(toolbarRect.right - (last?.right ?? 0)),
            }
        })
        expect(toolbarEdges).toEqual({ leftGap: 6, rightGap: 6 })

        const box = await dialog.boundingBox()
        expect(box?.width).toBeGreaterThanOrEqual(1400)
        expect(box?.height).toBeGreaterThanOrEqual(850)
        await expect(dialog.locator('[data-hapi-table-viewer="true"] .aui-md-thead')).toBeVisible()
        const wrapButton = dialog.getByRole('button', { name: 'Enable table wrapping' })
        await expect(wrapButton).toHaveAttribute('aria-pressed', 'false')
        await wrapButton.click()
        await expect(dialog.getByRole('button', { name: 'Disable table wrapping' })).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(() => dialog.locator('[data-hapi-table-viewer="true"]').evaluate((element) => {
            const table = element.querySelector('table')
            const cell = table?.querySelector('td')
            return table && cell
                ? `${getComputedStyle(element).overflowX}:${getComputedStyle(table).tableLayout}:${getComputedStyle(cell).whiteSpace}`
                : ''
        })).toBe('hidden:fixed:normal')
        await expect.poll(async () => {
            const toolbarHeight = (await toolbar.boundingBox())?.height ?? 0
            const headerHeight = await dialog.locator('[data-hapi-table-viewer="true"] thead').evaluate((element) => element.getBoundingClientRect().height)
            return Math.round(toolbarHeight) - Math.round(headerHeight)
        }).toBe(-4)
        const viewerLeftOffset = await dialog.locator('[data-hapi-table-viewer="true"]').evaluate((element) => {
            const table = element.querySelector('table')
            if (!table) return -1
            return Math.round(table.getBoundingClientRect().left - element.getBoundingClientRect().left)
        })
        expect(viewerLeftOffset).toBe(0)
        await expect.poll(() => dialog.locator('[data-hapi-table-viewer="true"]').evaluate((element) => getComputedStyle(element).paddingRight)).toBe('0px')
        await expect.poll(() => dialog.locator('[data-hapi-table-viewer="true"]').evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('0px')

        await page.evaluate(() => {
            let copied = ''
            Object.defineProperty(window, '__hapiCopiedTableMarkdown', {
                configurable: true,
                get: () => copied,
            })
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText: async (text: string) => { copied = text } },
            })
        })
        await dialog.getByRole('button', { name: 'Copy table' }).click()
        await expect(page.getByRole('menuitem').nth(0)).toHaveText('Copy image')
        await expect(page.getByRole('menuitem').nth(1)).toHaveText('Copy Markdown')
        await page.getByRole('menuitem', { name: 'Copy Markdown' }).click()
        await expect.poll(() => page.evaluate(() => (window as Window & { __hapiCopiedTableMarkdown?: string }).__hapiCopiedTableMarkdown ?? '')).toContain('| Project | Stars |')

        const imageDownloadPromise = page.waitForEvent('download')
        await dialog.getByRole('button', { name: 'Download table' }).click()
        await expect(page.getByRole('menuitem', { name: 'Download PNG' })).toBeVisible()
        await expect(page.getByRole('menuitem', { name: 'Download CSV' })).toBeVisible()
        await page.getByRole('menuitem', { name: 'Download PNG' }).click()
        const imageDownload = await imageDownloadPromise
        expect(imageDownload.suggestedFilename()).toMatch(/^HAPI Table-Table filename fixture-\d{14}\.png$/)
        const imagePath = await imageDownload.path()
        if (!imagePath) throw new Error('PNG download did not produce a file path')
        const png = await readFile(imagePath)
        expect(png.subarray(1, 4).toString()).toBe('PNG')
        const exportedHeight = png.readUInt32BE(20)
        const tableExportMetrics = await dialog.locator('[data-hapi-table-viewer="true"] table').evaluate((table) => {
            const tableRect = table.getBoundingClientRect()
            const rowBottoms = Array.from(table.rows)
                .map((row) => row.getBoundingClientRect())
                .filter((rowRect) => rowRect.height > 0)
                .map((rowRect) => rowRect.bottom - tableRect.top)
            const fallbackHeight = Math.max(table.scrollHeight, Math.ceil(tableRect.height), 1)
            const height = rowBottoms.length > 0
                ? Math.min(fallbackHeight, Math.ceil(Math.max(...rowBottoms)))
                : fallbackHeight
            return {
                width: Math.max(table.scrollWidth, Math.ceil(tableRect.width), 1),
                height,
                devicePixelRatio: window.devicePixelRatio,
            }
        })
        const scale = Math.min(
            tableExportMetrics.devicePixelRatio || 1,
            2,
            Math.sqrt(36_000_000 / (tableExportMetrics.width * tableExportMetrics.height)),
        )
        expect(exportedHeight).toBe(Math.ceil(tableExportMetrics.height * scale))

        const downloadPromise = page.waitForEvent('download')
        await dialog.getByRole('button', { name: 'Download table' }).click()
        await expect(page.getByRole('menuitem', { name: 'Download CSV' })).toBeVisible()
        await page.getByRole('menuitem', { name: 'Download CSV' }).click()
        const download = await downloadPromise
        expect(download.suggestedFilename()).toMatch(/^HAPI Table-Table filename fixture-\d{14}\.csv$/)

        await dialog.getByRole('button', { name: 'Close table full screen' }).click()
        await expect(dialog).toBeHidden()
    })

    test('sizes each action menu to its longest option with symmetric padding', async ({ page }) => {
        await page.goto('/e2e-fixtures/markdown-table-fixture.html')
        await page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-frame').hover()
        await page.getByRole('button', { name: 'Open table full screen' }).click()

        const dialog = page.getByRole('dialog', { name: 'Table filename fixture' })
        await expect(dialog).toBeVisible()

        const measureMenu = async (triggerName: string) => {
            await dialog.getByRole('button', { name: triggerName }).click()
            const menu = page.getByRole('menu', { name: triggerName })
            await expect(menu).toBeVisible()
            return menu.evaluate((element) => {
                const menuRect = element.getBoundingClientRect()
                const options = Array.from(element.querySelectorAll('button')).map((button) => {
                    const range = document.createRange()
                    range.selectNodeContents(button)
                    const textRect = range.getBoundingClientRect()
                    return {
                        text: button.textContent,
                        textWidth: textRect.width,
                        leftGap: textRect.left - menuRect.left,
                        rightGap: menuRect.right - textRect.right,
                    }
                })
                const longest = options.reduce((current, option) => {
                    const currentWidth = current.textWidth
                    const optionWidth = option.textWidth
                    return optionWidth > currentWidth ? option : current
                })
                return { options, longest }
            })
        }

        const copyMenu = await measureMenu('Copy table')
        expect(copyMenu.options.map((option) => option.text)).toEqual(['Copy image', 'Copy Markdown'])
        expect(Math.abs(copyMenu.longest.leftGap - copyMenu.longest.rightGap)).toBeLessThanOrEqual(1)
        await page.keyboard.press('Escape')

        const downloadMenu = await measureMenu('Download table')
        expect(downloadMenu.options.map((option) => option.text)).toEqual(['Download PNG', 'Download CSV'])
        expect(Math.abs(downloadMenu.longest.leftGap - downloadMenu.longest.rightGap)).toBeLessThanOrEqual(1)
    })

    test('keeps file-preview table header geometry aligned with chat tables', async ({ page }) => {
        await page.goto('/e2e-fixtures/markdown-table-fixture.html')

        const surface = page.locator('[data-testid="markdown-table-fixture"]')
        const readGeometry = () => surface.evaluate((element) => {
            const table = element.querySelector('table')
            const header = table?.querySelector('thead th')
            const frame = element.querySelector<HTMLElement>('.aui-md-table-frame')
            const actions = element.querySelector('.aui-md-table-actions')
            if (!table || !header || !frame || !actions) throw new Error('Markdown table geometry is incomplete')

            const frameRect = frame.getBoundingClientRect()
            const actionRect = actions.getBoundingClientRect()
            const headerStyle = getComputedStyle(header)
            return {
                paddingTop: headerStyle.paddingTop,
                paddingBottom: headerStyle.paddingBottom,
                paddingLeft: headerStyle.paddingLeft,
                paddingRight: headerStyle.paddingRight,
                lineHeight: headerStyle.lineHeight,
                actionTopOffset: Math.round(actionRect.top - frameRect.top),
                actionRightOffset: Math.round(frameRect.right - actionRect.right),
            }
        })

        const chatGeometry = await readGeometry()
        await surface.evaluate((element) => element.classList.add('markdown-content'))
        const filePreviewGeometry = await readGeometry()

        expect(filePreviewGeometry).toEqual(chatGeometry)
        expect(filePreviewGeometry.actionTopOffset).toBe(3)
        expect(filePreviewGeometry.actionRightOffset).toBe(3)
    })

    test('keeps the inline fullscreen action fixed at the table top-right when the header wraps', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 900 })
        await page.goto('/e2e-fixtures/markdown-table-fixture.html')

        const surface = page.locator('[data-testid="markdown-table-fixture"]')
        const geometry = await surface.evaluate((element) => {
            const frame = element.querySelector<HTMLElement>('.aui-md-table-frame')
            const row = frame?.querySelector<HTMLTableRowElement>('thead > tr')
            const actions = frame?.querySelector<HTMLElement>('.aui-md-table-actions')
            if (!frame || !row || !actions) throw new Error('Wrapped table geometry is incomplete')

            const frameRect = frame.getBoundingClientRect()
            const rowRect = row.getBoundingClientRect()
            const actionRect = actions.getBoundingClientRect()
            return {
                headerHeight: Math.round(rowRect.height),
                actionHeight: Math.round(actionRect.height),
                topOffset: Math.round(actionRect.top - frameRect.top),
                rightOffset: Math.round(frameRect.right - actionRect.right),
            }
        })

        expect(geometry.headerHeight).toBeGreaterThan(geometry.actionHeight)
        expect(geometry.topOffset).toBe(3)
        expect(geometry.rightOffset).toBe(3)
    })

    test('defaults an overflowing table to wrapping and remembers an explicit choice', async ({ page }) => {
        await page.setViewportSize({ width: 600, height: 900 })
        await page.goto('/e2e-fixtures/markdown-table-fixture.html')
        await page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-frame').hover()
        await page.getByRole('button', { name: 'Open table full screen' }).click()

        const dialog = page.getByRole('dialog', { name: 'Table filename fixture' })
        await expect(dialog).toBeVisible()
        const wrappedButton = dialog.getByRole('button', { name: 'Disable table wrapping' })
        await expect(wrappedButton).toHaveAttribute('aria-pressed', 'true')
        await expect.poll(() => dialog.locator('[data-hapi-table-viewer="true"]').evaluate((element) => {
            const table = element.querySelector('table')
            return table && element.scrollWidth <= element.clientWidth
                ? `${getComputedStyle(table).tableLayout}:${getComputedStyle(element).overflowX}`
                : ''
        })).toBe('fixed:hidden')

        await wrappedButton.click()
        await expect(dialog.getByRole('button', { name: 'Enable table wrapping' })).toHaveAttribute('aria-pressed', 'false')
        await dialog.getByRole('button', { name: 'Close table full screen' }).click()
        await expect(dialog).toBeHidden()

        await page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-frame').hover()
        await page.getByRole('button', { name: 'Open table full screen' }).click()
        const reopenedDialog = page.getByRole('dialog', { name: 'Table filename fixture' })
        await expect(reopenedDialog).toBeVisible()
        await expect(reopenedDialog.getByRole('button', { name: 'Enable table wrapping' })).toHaveAttribute('aria-pressed', 'false')
    })

    test('does not rebound at the bottom when toolbar space exceeds remaining table overflow', async ({ page }) => {
        await page.setViewportSize({ width: 1200, height: 500 })
        await page.goto('/e2e-fixtures/markdown-table-fixture.html?near-bottom-scroll')
        await page.locator('[data-testid="markdown-table-fixture"] .aui-md-table-frame').hover()
        await page.getByRole('button', { name: 'Open table full screen' }).click()

        const dialog = page.getByRole('dialog', { name: 'Table filename fixture' })
        const viewer = dialog.locator('[data-hapi-table-viewer="true"]')
        await expect(dialog).toBeVisible()
        await expect.poll(() => viewer.evaluate((element) => element.scrollHeight > element.clientHeight && element.scrollWidth <= element.clientWidth + 1)).toBe(true)

        await expect(dialog.getByRole('button', { name: 'Enable table wrapping' })).toHaveAttribute('aria-pressed', 'false')
        const viewerBox = await viewer.boundingBox()
        if (!viewerBox) throw new Error('Long table viewer has no bounding box')
        await page.mouse.move(viewerBox.x + viewerBox.width / 2, viewerBox.y + viewerBox.height / 2)
        const readScrollState = () => viewer.evaluate((element) => ({
            scrollTop: element.scrollTop,
            maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
            toolbarHidden: document.querySelector('[data-hapi-table-viewer-toolbar="true"]')?.getAttribute('aria-hidden') === 'true',
        }))
        await page.mouse.wheel(0, 10_000)
        const bottomSamples = [await readScrollState()]
        for (let index = 0; index < 12; index += 1) {
            await page.waitForTimeout(25)
            bottomSamples.push(await readScrollState())
        }

        expect(bottomSamples.at(-1)?.scrollTop).toBeGreaterThanOrEqual((bottomSamples.at(-1)?.maxScrollTop ?? 0) - 1)
        expect(bottomSamples.some((sample) => sample.toolbarHidden)).toBe(false)
        for (let index = 1; index < bottomSamples.length; index += 1) {
            expect(bottomSamples[index]?.scrollTop).toBeGreaterThanOrEqual((bottomSamples[index - 1]?.scrollTop ?? 0) - 1)
        }
    })
})
