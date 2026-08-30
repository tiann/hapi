import { devices, expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

function pngSize(bytes: Buffer): { width: number; height: number } {
    expect(bytes.subarray(1, 4).toString()).toBe('PNG')
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

for (const viewport of [
    { name: 'desktop', width: 1280, height: 2200, theme: 'light' },
    { name: 'mobile', width: 390, height: 844, theme: 'light' },
    { name: 'mobile-dark', width: 390, height: 844, theme: 'dark' }
]) {
    test(`exports a populated wide PNG on ${viewport.name}`, async ({ page }, testInfo) => {
        let stylesheetRequests = 0
        await page.route('**/share-turn-extra.css', async (route) => {
            stylesheetRequests += 1
            if (stylesheetRequests === 1) {
                await route.fulfill({
                    contentType: 'text/css',
                    headers: { 'cache-control': 'no-store' },
                    body: '.share-turn-network-style{border-left:5px solid rgb(124 58 237);border-radius:14px;background:rgb(124 58 237 / 10%);padding:12px 16px}'
                })
                return
            }
            await route.abort()
        })
        await page.setViewportSize(viewport)
        await page.goto(`/e2e-fixtures/share-turn-fixture.html?theme=${viewport.theme}`)

        await expect(page.getByText('Complex response fixture')).toBeVisible()
        await expect(page.getByText('Excluded tool output')).toBeVisible()
        await expect(page.getByText(/type ExportResult/)).toBeVisible()
        await page.getByTestId('source-turn').screenshot({ path: testInfo.outputPath(`source-${viewport.name}.png`) })
        await page.getByRole('button', { name: 'Open share preview' }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(page.getByRole('dialog').getByText('Excluded tool output')).toHaveCount(0)
        await expect(page.getByRole('dialog').locator('.happy-message-actions')).toHaveCount(0)
        await expect(page.getByRole('dialog').locator('.hapi-share-hidden-content-spacer')).toHaveCount(1)
        await expect(page.getByRole('dialog').locator('[title="Click to zoom"]')).toHaveCount(2)
        if (viewport.name === 'desktop') {
            const styles = await page.evaluate(() => {
                const source = document.querySelector<HTMLElement>('[data-testid="source-turn"]')
                const preview = document.querySelector<HTMLElement>('[data-hapi-share-body="true"]')
                if (!source || !preview) throw new Error('Missing comparison roots')
                const selectors = ['.happy-user-bubble', 'h2', 'blockquote', 'table', 'pre']
                const properties = ['fontFamily', 'fontSize', 'fontWeight', 'color', 'backgroundColor', 'borderRadius'] as const
                return selectors.map((selector) => {
                    const sourceElement = source.querySelector<HTMLElement>(selector)
                    const previewElement = preview.querySelector<HTMLElement>(selector)
                    if (!sourceElement || !previewElement) throw new Error(`Missing ${selector}`)
                    const sourceStyle = getComputedStyle(sourceElement)
                    const previewStyle = getComputedStyle(previewElement)
                    return properties.map((property) => [sourceStyle[property], previewStyle[property]])
                })
            })
            for (const pairs of styles) {
                for (const [sourceValue, previewValue] of pairs) {
                    expect(previewValue).toBe(sourceValue)
                }
            }
            const mediaGrid = page.getByRole('dialog').locator('.hapi-share-media-grid')
            await expect(mediaGrid).toHaveCSS('display', 'flex')
            const imageTops = await mediaGrid.locator('img').evaluateAll((images) => images.map((image) => image.getBoundingClientRect().top))
            expect(imageTops).toHaveLength(2)
            expect(Math.abs(imageTops[0] - imageTops[1])).toBeLessThan(1)
        }
        const downloadPromise = page.waitForEvent('download')
        await page.getByRole('button', { name: /^(Download|下载)$/ }).click()
        const download = await downloadPromise
        const path = testInfo.outputPath(`share-turn-${viewport.name}.png`)
        await download.saveAs(path)

        const bytes = await readFile(path)
        const size = pngSize(bytes)
        expect(download.suggestedFilename()).toMatch(/^HAPI-Complex HAPI turn-\d{14}\.png$/)
        expect(bytes.byteLength).toBeGreaterThan(80_000)
        expect(size.width).toBe(1920)
        expect(size.height).toBeGreaterThan(1_000)
        expect(stylesheetRequests).toBe(1)
    })
}

test('exports a text-only user fallback alongside assistant DOM', async ({ page }, testInfo) => {
    await page.goto('/e2e-fixtures/share-turn-fixture.html?fallback=user')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/这个失败不用说吧/)).toBeVisible()
    await expect(dialog.getByText('Complex response fixture')).toBeVisible()
    await dialog.screenshot({ path: testInfo.outputPath('fallback-preview.png') })

    const downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: /^(Download|下载)$/ }).click()
    const download = await downloadPromise
    const path = testInfo.outputPath('fallback-export.png')
    await download.saveAs(path)

    const bytes = await readFile(path)
    const size = pngSize(bytes)
    expect(bytes.byteLength).toBeGreaterThan(80_000)
    expect(size.width).toBe(1920)
    expect(size.height).toBeGreaterThan(1_000)
})

test('keeps a stripped tool-only assistant snapshot out of the export', async ({ page }, testInfo) => {
    await page.goto('/e2e-fixtures/share-turn-fixture.html?toolOnly=assistant')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Complex response fixture')).toBeVisible()
    await expect(dialog.getByText('TOOL_ONLY_SECRET_SHOULD_NOT_EXPORT')).toHaveCount(0)

    const downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: /^(Download|下载)$/ }).click()
    const download = await downloadPromise
    const path = testInfo.outputPath('tool-only-excluded-export.png')
    await download.saveAs(path)

    const bytes = await readFile(path)
    const size = pngSize(bytes)
    expect(bytes.byteLength).toBeGreaterThan(80_000)
    expect(size.width).toBe(1920)
    expect(size.height).toBeGreaterThan(1_000)
})

test('localizes the share dialog actions in Chinese', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi-lang', 'zh-CN'))
    await page.goto('/e2e-fixtures/share-turn-fixture.html')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: '将本轮对话分享为图片' })).toBeVisible()
    await expect(dialog.locator('[data-hapi-share-control="fullscreen"]')).toHaveAttribute('aria-label', '打开全屏预览')
    await expect(dialog.getByText('分享会话', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('Generated by HAPI', { exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '取消' })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: '复制' }).last()).toBeVisible()
    await expect(dialog.getByRole('button', { name: '分享' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '下载' })).toBeVisible()
})

test('aligns the generated watermark to the bottom right', async ({ page }) => {
    await page.goto('/e2e-fixtures/share-turn-fixture.html')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Generated by HAPI', { exact: true })).toHaveCSS('text-align', 'right')
})

test('matches configured session-header metadata in the share preview', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi-session-header-metadata', JSON.stringify({
        showLabels: false,
        agent: false,
        model: false,
        reasoning: false,
        fastMode: false,
        machine: false,
        lastActive: false,
        createdAt: true,
        updatedAt: true,
        worktree: false,
    })))
    await page.goto('/e2e-fixtures/share-turn-fixture.html')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Aug 2, 2026, 10:00 AM', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Aug 2, 2026, 10:30 AM', { exact: true })).toBeVisible()
    await expect(dialog.getByText('Created:', { exact: false })).toHaveCount(0)
    await expect(dialog.getByText('codex', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('fixture-host', { exact: false })).toHaveCount(0)
    await expect(dialog.getByText('gpt-5.6-sol', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('feat/share-turn-polish', { exact: false })).toHaveCount(0)
})

test('keeps code and image controls interactive in preview', async ({ page }, testInfo) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/e2e-fixtures/share-turn-fixture.html')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const dialog = page.getByRole('dialog', { name: 'Share turn as image' })
    const fullscreenButton = dialog.locator('[data-hapi-share-control="fullscreen"]')
    await expect(fullscreenButton).toBeEnabled()
    const closeButton = dialog.locator('button[aria-label="Close"]')
    const fullscreenBox = await fullscreenButton.boundingBox()
    const closeBox = await closeButton.boundingBox()
    const dialogBox = await dialog.boundingBox()
    expect(fullscreenBox).not.toBeNull()
    expect(closeBox).not.toBeNull()
    expect(dialogBox).not.toBeNull()
    expect(fullscreenBox?.x ?? 0).toBeCloseTo((dialogBox?.x ?? 0) + 12, 0)
    expect(fullscreenBox?.y ?? 0).toBeCloseTo((dialogBox?.y ?? 0) + 8, 0)
    expect((closeBox?.x ?? 0) + (closeBox?.width ?? 0)).toBeCloseTo((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) - 12, 0)
    expect(closeBox?.y ?? 0).toBeCloseTo((dialogBox?.y ?? 0) + 8, 0)
    const fullscreenIconBox = await fullscreenButton.locator('svg').boundingBox()
    const closeIconBox = await closeButton.locator('svg').boundingBox()
    expect(fullscreenIconBox?.width ?? 0).toBeCloseTo(closeIconBox?.width ?? 0, 0)
    expect(fullscreenIconBox?.height ?? 0).toBeCloseTo(closeIconBox?.height ?? 0, 0)

    const shareAction = dialog.locator('[data-hapi-share-control="share"]')
    const copyAction = dialog.locator('[data-hapi-share-control="copy"]')
    const downloadAction = dialog.locator('[data-hapi-share-control="download"]')
    const shareBox = await shareAction.boundingBox()
    const copyBox = await copyAction.boundingBox()
    const downloadBox = await downloadAction.boundingBox()
    expect(copyBox?.x ?? 0).toBeLessThan(shareBox?.x ?? 0)
    expect(shareBox?.x ?? 0).toBeLessThan(downloadBox?.x ?? 0)

    const initialDialogBox = await dialog.boundingBox()
    const previewSurface = dialog.locator('.hapi-share-preview-root')
    const previewScroll = dialog.locator('.hapi-share-preview-scroll')
    await expect(previewSurface).toHaveClass(/sm:px-5/)
    await expect(previewSurface).toHaveCSS('padding-left', '14px')
    const measureHeaderSpacing = async () => await dialog.evaluate((element) => {
        const dialogBox = element.getBoundingClientRect()
        const title = element.querySelector('h2')
        const preview = element.querySelector<HTMLElement>('.hapi-share-preview-scroll')
        const actions = element.querySelector<HTMLElement>('[data-hapi-share-control="download"]')?.parentElement
        const root = element.querySelector<HTMLElement>('.hapi-share-preview-root')
        const footer = element.querySelector<HTMLElement>('[data-hapi-share-footer="true"]')
        if (!title || !preview || !actions || !root || !footer) throw new Error('Missing share dialog spacing elements')
        const titleBox = title.getBoundingClientRect()
        const previewBox = preview.getBoundingClientRect()
        const actionsBox = actions.getBoundingClientRect()
        const rootStyle = getComputedStyle(root)
        const footerStyle = getComputedStyle(footer)
        return {
            topToTitle: titleBox.top - dialogBox.top,
            titleToPreview: previewBox.top - titleBox.bottom,
            previewToActions: actionsBox.top - previewBox.bottom,
            actionsToBottom: dialogBox.bottom - actionsBox.bottom,
            rootPaddingTop: parseFloat(rootStyle.paddingTop),
            rootPaddingBottom: parseFloat(rootStyle.paddingBottom),
            footerPaddingTop: parseFloat(footerStyle.paddingTop)
        }
    })
    const measureFooterSpacing = async () => await previewScroll.evaluate((element) => {
        const root = element.querySelector<HTMLElement>('.hapi-share-preview-root')
        const footer = root?.querySelector<HTMLElement>('[data-hapi-share-footer="true"]')
        const watermark = root?.querySelector<HTMLElement>('[data-hapi-share-watermark="true"]')
        if (!root || !footer || !watermark) throw new Error('Missing share footer elements')
        const previousScrollTop = element.scrollTop
        element.scrollTop = element.scrollHeight
        const footerBox = footer.getBoundingClientRect()
        const watermarkBox = watermark.getBoundingClientRect()
        const scrollBox = element.getBoundingClientRect()
        const result = {
            dividerToWatermark: watermarkBox.top - footerBox.top,
            watermarkToScrollBottom: scrollBox.bottom - watermarkBox.bottom,
            scrollPaddingBottom: parseFloat(getComputedStyle(element).paddingBottom)
        }
        element.scrollTop = previousScrollTop
        return result
    })
    const measurePreviewGaps = async () => await previewScroll.evaluate((element) => {
        const root = element.querySelector<HTMLElement>('.hapi-share-preview-root')
        if (!root) throw new Error('Missing share preview root')
        const title = root.querySelector<HTMLElement>('.text-lg')
        if (!title) throw new Error('Missing share preview title')
        const scrollBox = element.getBoundingClientRect()
        const titleBox = title.getBoundingClientRect()
        const styles = getComputedStyle(element)
        return {
            left: titleBox.left - scrollBox.left,
            right: scrollBox.right - titleBox.right,
            top: titleBox.top - scrollBox.top,
            scrollbarGutter: styles.scrollbarGutter
        }
    })
    const initialPreviewWidth = await previewSurface.boundingBox()
    expect(initialDialogBox).not.toBeNull()
    expect(initialPreviewWidth).not.toBeNull()
    const initialPreviewGaps = await measurePreviewGaps()
    expect(initialPreviewGaps.scrollbarGutter).toContain('stable both-edges')
    expect(Math.abs(initialPreviewGaps.left - initialPreviewGaps.right)).toBeLessThan(1)
    // Desktop title glyphs sit about 4px below their 21px line-box inset;
    // the visible ink therefore aligns with the 25px horizontal inset.
    expect(initialPreviewGaps.left).toBeCloseTo(25, 0)
    expect(initialPreviewGaps.right).toBeCloseTo(25, 0)
    expect(initialPreviewGaps.top).toBeCloseTo(14, 0)
    const initialHeaderSpacing = await measureHeaderSpacing()
    expect(initialHeaderSpacing.topToTitle).toBeCloseTo(16, 0)
    expect(initialHeaderSpacing.titleToPreview).toBeCloseTo(16, 0)
    expect(initialHeaderSpacing.previewToActions).toBeCloseTo(16, 0)
    expect(initialHeaderSpacing.actionsToBottom).toBeCloseTo(16, 0)
    expect(initialHeaderSpacing.rootPaddingTop).toBeCloseTo(1, 0)
    expect(initialHeaderSpacing.rootPaddingBottom).toBeCloseTo(12, 0)
    expect(initialHeaderSpacing.footerPaddingTop).toBeCloseTo(12, 0)
    const initialFooterSpacing = await measureFooterSpacing()
    expect(initialFooterSpacing.watermarkToScrollBottom).toBeCloseTo(initialFooterSpacing.dividerToWatermark, 0)
    expect(initialFooterSpacing.scrollPaddingBottom).toBeCloseTo(0, 0)

    await fullscreenButton.click()
    await expect(fullscreenButton).toHaveAttribute('aria-label', 'Exit full-screen preview')
    const fullScreenDialogBox = await dialog.boundingBox()
    const fullScreenPreviewWidth = await previewSurface.boundingBox()
    expect(fullScreenDialogBox).not.toBeNull()
    expect(fullScreenPreviewWidth).not.toBeNull()
    expect(fullScreenDialogBox?.x ?? 0).toBe(0)
    expect(fullScreenDialogBox?.y ?? 0).toBe(0)
    expect(fullScreenDialogBox?.width ?? 0).toBeGreaterThan(initialDialogBox?.width ?? 0)
    expect(fullScreenDialogBox?.height ?? 0).toBeGreaterThan(initialDialogBox?.height ?? 0)
    expect(fullScreenPreviewWidth?.width ?? 0).toBeGreaterThan(initialPreviewWidth?.width ?? 0)
    const fullScreenPreviewGaps = await measurePreviewGaps()
    expect(fullScreenPreviewGaps.scrollbarGutter).toContain('stable both-edges')
    expect(Math.abs(fullScreenPreviewGaps.left - fullScreenPreviewGaps.right)).toBeLessThan(1)
    expect(fullScreenPreviewGaps.left).toBeCloseTo(25, 0)
    expect(fullScreenPreviewGaps.right).toBeCloseTo(25, 0)
    expect(fullScreenPreviewGaps.top).toBeCloseTo(14, 0)
    const fullScreenHeaderSpacing = await measureHeaderSpacing()
    expect(fullScreenHeaderSpacing.topToTitle).toBeCloseTo(16, 0)
    expect(fullScreenHeaderSpacing.titleToPreview).toBeCloseTo(16, 0)
    expect(fullScreenHeaderSpacing.previewToActions).toBeCloseTo(16, 0)
    expect(fullScreenHeaderSpacing.actionsToBottom).toBeCloseTo(16, 0)
    expect(fullScreenHeaderSpacing.rootPaddingTop).toBeCloseTo(1, 0)
    expect(fullScreenHeaderSpacing.rootPaddingBottom).toBeCloseTo(12, 0)
    expect(fullScreenHeaderSpacing.footerPaddingTop).toBeCloseTo(12, 0)
    const fullScreenFooterSpacing = await measureFooterSpacing()
    expect(fullScreenFooterSpacing.watermarkToScrollBottom).toBeCloseTo(fullScreenFooterSpacing.dividerToWatermark, 0)
    expect(fullScreenFooterSpacing.scrollPaddingBottom).toBeCloseTo(0, 0)
    await expect(dialog.getByText(/type ExportResult/)).toBeVisible()

    const selectedText = await dialog.locator('[data-hapi-share-body="true"]').evaluate((element) => {
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(element)
        selection?.removeAllRanges()
        selection?.addRange(range)
        const text = selection?.toString() ?? ''
        selection?.removeAllRanges()
        return text
    })
    expect(selectedText).toContain('type ExportResult')

    const fullScreenCopyButton = dialog.locator('[data-hapi-code-copy="true"]').first()
    await fullScreenCopyButton.click()
    await expect(fullScreenCopyButton).toHaveAttribute('title', 'Copied')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('type ExportResult')

    await fullscreenButton.click()
    await expect(fullscreenButton).toHaveAttribute('aria-label', 'Open full-screen preview')
    await expect(dialog).toBeVisible()

    const wrapButton = dialog.locator('[data-hapi-code-wrap-toggle="true"]').first()
    await expect(wrapButton).toHaveAttribute('aria-pressed', 'false')

    const unwrappedDownloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download' }).click()
    const unwrappedDownload = await unwrappedDownloadPromise
    const unwrappedPath = testInfo.outputPath('interactive-unwrapped.png')
    await unwrappedDownload.saveAs(unwrappedPath)
    const unwrappedSize = pngSize(await readFile(unwrappedPath))
    expect(unwrappedSize.width).toBe(1920)

    await wrapButton.click()
    await expect(wrapButton).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.locator('[data-code-cell]').first()).toHaveCSS('white-space', 'pre-wrap')

    const wrappedDownloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download' }).click()
    const wrappedDownload = await wrappedDownloadPromise
    const wrappedPath = testInfo.outputPath('interactive-wrapped.png')
    await wrappedDownload.saveAs(wrappedPath)
    const wrappedSize = pngSize(await readFile(wrappedPath))
    expect(wrappedSize.height).toBeGreaterThan(unwrappedSize.height)

    const copyButton = dialog.locator('[data-hapi-code-copy="true"]').first()
    await copyButton.click()
    await expect(copyButton).toHaveAttribute('title', 'Copied')
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('type ExportResult')

    const previewImage = dialog.locator('[data-image-preview-trigger] img').first()
    const previewImageBox = await previewImage.boundingBox()
    await previewImage.click()
    const imageDialog = page.getByRole('dialog', { name: 'HAPI landscape export fixture' })
    await expect(imageDialog).toBeVisible()
    const lightboxImageBox = await imageDialog.getByRole('img', { name: 'HAPI landscape export fixture' }).boundingBox()
    expect(lightboxImageBox?.width ?? 0).toBeGreaterThan(previewImageBox?.width ?? 0)
    const fitButton = imageDialog.getByTitle('Fit to screen')
    await expect(fitButton).toHaveText('100%')
    await imageDialog.getByRole('img', { name: 'HAPI landscape export fixture' }).hover()
    await page.mouse.wheel(0, -100)
    await expect(fitButton).not.toHaveText('100%')

    await page.keyboard.press('Tab')
    await expect(imageDialog.locator(':focus')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'HAPI landscape export fixture' })).toHaveCount(0)
    await expect(dialog).toBeVisible()
})

test('remembers the fullscreen preference across share dialog openings', async ({ page }) => {
    await page.addInitScript(() => localStorage.removeItem('hapi-share-preview-fullscreen'))
    await page.goto('/e2e-fixtures/share-turn-fixture.html')

    const openPreview = page.getByRole('button', { name: 'Open share preview' })
    await openPreview.click()
    let dialog = page.getByRole('dialog', { name: 'Share turn as image' })
    const fullscreenButton = dialog.locator('[data-hapi-share-control="fullscreen"]')
    await expect(fullscreenButton).toHaveAttribute('aria-label', 'Open full-screen preview')

    await fullscreenButton.click()
    await expect(fullscreenButton).toHaveAttribute('aria-label', 'Exit full-screen preview')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hapi-share-preview-fullscreen'))).toBe('true')

    await dialog.locator('button[aria-label="Close"]').click()
    await expect(dialog).toHaveCount(0)

    await openPreview.click()
    dialog = page.getByRole('dialog', { name: 'Share turn as image' })
    await expect(dialog.locator('[data-hapi-share-control="fullscreen"]')).toHaveAttribute('aria-label', 'Exit full-screen preview')

    await dialog.locator('[data-hapi-share-control="fullscreen"]').click()
    await expect(dialog.locator('[data-hapi-share-control="fullscreen"]')).toHaveAttribute('aria-label', 'Open full-screen preview')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hapi-share-preview-fullscreen'))).toBe('false')

    await dialog.locator('button[aria-label="Close"]').click()
    await expect(dialog).toHaveCount(0)
    await openPreview.click()
    await expect(page.getByRole('dialog', { name: 'Share turn as image' }).locator('[data-hapi-share-control="fullscreen"]'))
        .toHaveAttribute('aria-label', 'Open full-screen preview')
})

test('keeps the mobile preview canvas margins symmetric before and after fullscreen', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 13'] })
    const page = await context.newPage()
    try {
        await page.addInitScript(() => {
            document.documentElement.style.setProperty('--tg-viewport-stable-height', '640px')
        })
        await page.goto('/e2e-fixtures/share-turn-fixture.html')
        await page.getByRole('button', { name: 'Open share preview' }).click()

        const dialog = page.getByRole('dialog', { name: 'Share turn as image' })
        const fullscreenButton = dialog.locator('[data-hapi-share-control="fullscreen"]')
        const scroll = dialog.locator('.hapi-share-preview-scroll')
        const dialogHeading = dialog.getByRole('heading', { name: 'Share turn as image' })
        const measureHeaderSpacing = async () => await dialog.evaluate((element) => {
            const dialogBox = element.getBoundingClientRect()
            const title = element.querySelector('h2')
            const preview = element.querySelector<HTMLElement>('.hapi-share-preview-scroll')
            const actions = element.querySelector<HTMLElement>('[data-hapi-share-control="download"]')?.parentElement
            if (!title || !preview || !actions) throw new Error('Missing mobile share dialog spacing elements')
            const titleBox = title.getBoundingClientRect()
            const previewBox = preview.getBoundingClientRect()
            const actionsBox = actions.getBoundingClientRect()
            return {
                topToTitle: titleBox.top - dialogBox.top,
                titleToPreview: previewBox.top - titleBox.bottom,
                previewToActions: actionsBox.top - previewBox.bottom,
                actionsToBottom: dialogBox.bottom - actionsBox.bottom
            }
        })
        const measureControlCenters = async () => {
            const headingBox = await dialogHeading.boundingBox()
            const fullscreenBox = await fullscreenButton.boundingBox()
            const closeBox = await dialog.locator('button[aria-label="Close"]').boundingBox()
            if (!headingBox || !fullscreenBox || !closeBox) throw new Error('Missing mobile share control geometry')
            return {
                headingCenterY: headingBox.y + headingBox.height / 2,
                fullscreenCenterY: fullscreenBox.y + fullscreenBox.height / 2,
                closeCenterY: closeBox.y + closeBox.height / 2
            }
        }
        const measureGaps = async () => await scroll.evaluate((element) => {
            const root = element.querySelector<HTMLElement>('.hapi-share-preview-root')
            if (!root) throw new Error('Missing share preview root')
            const scrollBox = element.getBoundingClientRect()
            const rootBox = root.getBoundingClientRect()
            const styles = getComputedStyle(element)
            const dialogElement = element.closest<HTMLElement>('[role="dialog"]')
            if (!dialogElement) throw new Error('Missing share preview dialog')
            const dialogStyles = getComputedStyle(dialogElement)
            const rootStyles = getComputedStyle(root)
            return {
                left: rootBox.left - scrollBox.left,
                right: scrollBox.right - rootBox.right,
                scrollbarGutter: styles.scrollbarGutter,
                paddingInline: parseFloat(styles.paddingLeft),
                dialogPaddingInline: parseFloat(dialogStyles.paddingLeft),
                rootPaddingInline: parseFloat(rootStyles.paddingLeft),
                rootPaddingTop: parseFloat(rootStyles.paddingTop),
                rootPaddingBottom: parseFloat(rootStyles.paddingBottom)
            }
        })

        const initialGaps = await measureGaps()
        expect(initialGaps.scrollbarGutter).toContain('stable both-edges')
        expect(initialGaps.paddingInline).toBeCloseTo(4, 1)
        expect(initialGaps.dialogPaddingInline).toBeCloseTo(16, 1)
        expect(initialGaps.rootPaddingInline).toBeCloseTo(8, 1)
        expect(initialGaps.rootPaddingTop).toBeCloseTo(12, 1)
        expect(initialGaps.rootPaddingBottom).toBeCloseTo(8, 1)
        expect(initialGaps.paddingInline).toBeCloseTo(4, 1)
        expect(Math.abs(initialGaps.left - initialGaps.right)).toBeLessThan(1)
        const initialControlCenters = await measureControlCenters()
        expect(initialControlCenters.fullscreenCenterY).toBeCloseTo(initialControlCenters.headingCenterY, 0)
        expect(initialControlCenters.closeCenterY).toBeCloseTo(initialControlCenters.headingCenterY, 0)
        const initialHeaderSpacing = await measureHeaderSpacing()
        expect(initialHeaderSpacing.topToTitle).toBeCloseTo(16, 0)
        expect(initialHeaderSpacing.titleToPreview).toBeCloseTo(16, 0)
        expect(initialHeaderSpacing.previewToActions).toBeCloseTo(16, 0)
        expect(initialHeaderSpacing.actionsToBottom).toBeCloseTo(16, 0)

        await fullscreenButton.click()
        await expect(fullscreenButton).toHaveAttribute('aria-label', 'Exit full-screen preview')
        const fullscreenDialogStyle = await dialog.evaluate((element) => ({
            height: element.style.height,
            paddingTop: element.style.paddingTop,
            paddingBottom: element.style.paddingBottom,
            fullscreenButtonTop: element.querySelector<HTMLElement>('[data-hapi-share-control="fullscreen"]')?.style.top,
            closeButtonTop: element.querySelector<HTMLElement>('button[aria-label="Close"]')?.className
        }))
        expect(fullscreenDialogStyle.height).toContain('--tg-viewport-stable-height')
        expect(fullscreenDialogStyle.paddingTop).toContain('safe-area-inset-top')
        expect(fullscreenDialogStyle.paddingBottom).toContain('safe-area-inset-bottom')
        expect(fullscreenDialogStyle.fullscreenButtonTop).toContain('safe-area-inset-top')
        expect(fullscreenDialogStyle.closeButtonTop).toContain('safe-area-inset-top')
        const fullscreenGaps = await measureGaps()
        expect(fullscreenGaps.scrollbarGutter).toContain('stable both-edges')
        expect(fullscreenGaps.paddingInline).toBeCloseTo(4, 1)
        expect(fullscreenGaps.dialogPaddingInline).toBeCloseTo(16, 1)
        expect(fullscreenGaps.rootPaddingInline).toBeCloseTo(8, 1)
        expect(fullscreenGaps.rootPaddingTop).toBeCloseTo(12, 1)
        expect(fullscreenGaps.rootPaddingBottom).toBeCloseTo(8, 1)
        expect(fullscreenGaps.paddingInline).toBeCloseTo(4, 1)
        expect(Math.abs(fullscreenGaps.left - fullscreenGaps.right)).toBeLessThan(1)
        const fullscreenControlCenters = await measureControlCenters()
        expect(fullscreenControlCenters.fullscreenCenterY).toBeCloseTo(fullscreenControlCenters.headingCenterY, 0)
        expect(fullscreenControlCenters.closeCenterY).toBeCloseTo(fullscreenControlCenters.headingCenterY, 0)
        const fullscreenHeaderSpacing = await measureHeaderSpacing()
        expect(fullscreenHeaderSpacing.topToTitle).toBeCloseTo(16, 0)
        expect(fullscreenHeaderSpacing.titleToPreview).toBeCloseTo(16, 0)
        expect(fullscreenHeaderSpacing.previewToActions).toBeCloseTo(16, 0)
        expect(fullscreenHeaderSpacing.actionsToBottom).toBeCloseTo(16, 0)
    } finally {
        await context.close()
    }
})

test('preserves the desktop source width but keeps mobile export width stable', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 })
    })
    await page.setViewportSize({ width: 1440, height: 1600 })
    await page.goto('/e2e-fixtures/share-turn-fixture.html?wide=1')
    const sourceWidth = await page.getByTestId('source-turn').evaluate((element) => element.getBoundingClientRect().width)
    expect(sourceWidth).toBe(1080)
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const preview = page.getByRole('dialog').locator('.hapi-share-preview-root')
    const previewWidth = await preview.evaluate((element) => element.getBoundingClientRect().width)
    expect(previewWidth).toBeGreaterThan(650)
    expect(previewWidth).toBeLessThanOrEqual(736)
    const inlineCode = preview.locator('.aui-md-code').last()
    await expect(inlineCode).toHaveCSS('display', 'inline')

    const desktopDownloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download' }).click()
    const desktopDownload = await desktopDownloadPromise
    const desktopPath = testInfo.outputPath('source-width-desktop.png')
    await desktopDownload.saveAs(desktopPath)
    expect(pngSize(await readFile(desktopPath)).width).toBe(2240)

    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await page.getByRole('button', { name: 'Open share preview' }).click()
    const mobileDownloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download' }).click()
    const mobileDownload = await mobileDownloadPromise
    const mobilePath = testInfo.outputPath('source-width-mobile.png')
    await mobileDownload.saveAs(mobilePath)
    expect(pngSize(await readFile(mobilePath)).width).toBe(1920)
})

test('keeps a landscape touch device on the fixed mobile export path', async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        const nativeMatchMedia = window.matchMedia.bind(window)
        window.matchMedia = (query: string) => {
            if (query !== '(pointer: coarse)') return nativeMatchMedia(query)
            return {
                matches: true,
                media: query,
                onchange: null,
                addListener: () => undefined,
                removeListener: () => undefined,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
                dispatchEvent: () => false,
            }
        }
    })
    await page.setViewportSize({ width: 844, height: 390 })
    await page.goto('/e2e-fixtures/share-turn-fixture.html?wide=1')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download' }).click()
    const download = await downloadPromise
    const path = testInfo.outputPath('landscape-touch-mobile.png')
    await download.saveAs(path)
    expect(pngSize(await readFile(path)).width).toBe(1920)
})

test('allows three or more attachments to wrap instead of shrinking into one row', async ({ page }) => {
    await page.goto('/e2e-fixtures/share-turn-fixture.html')
    await page.getByTestId('source-turn').evaluate((source) => {
        const grid = source.querySelector<HTMLElement>('.hapi-share-media-grid')
        const firstAttachment = grid?.querySelector<HTMLButtonElement>('button')
        if (!grid || !firstAttachment) throw new Error('Missing attachment fixture')
        grid.appendChild(firstAttachment.cloneNode(true))
        grid.dataset.hapiImageCount = '3'
    })
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const mediaGrid = page.getByRole('dialog').locator('.hapi-share-media-grid')
    await expect(mediaGrid).toHaveCSS('flex-wrap', 'wrap')
    await expect(mediaGrid.locator(':scope > button')).toHaveCount(3)
})

test('uses a prepared PNG while native share still has click activation', async ({ page }) => {
    await page.addInitScript(() => {
        const state = { calls: 0, active: false, fileType: '', fileName: '' }
        Object.defineProperty(window, '__hapiShareTest', { value: state, configurable: true })
        Object.defineProperty(navigator, 'canShare', {
            configurable: true,
            value: () => true
        })
        Object.defineProperty(navigator, 'share', {
            configurable: true,
            value: (data: ShareData) => {
                state.calls += 1
                state.active = navigator.userActivation?.isActive ?? false
                state.fileType = data.files?.[0]?.type ?? ''
                state.fileName = data.files?.[0]?.name ?? ''
                return Promise.resolve()
            }
        })
    })
    await page.goto('/e2e-fixtures/share-turn-fixture.html')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const shareButton = page.getByRole('dialog').getByRole('button', { name: 'Share' })
    await expect(shareButton).toBeEnabled()
    await shareButton.click()

    await expect.poll(() => page.evaluate(() => {
        return (window as typeof window & { __hapiShareTest: { calls: number } }).__hapiShareTest.calls
    })).toBe(1)
    const result = await page.evaluate(() => {
        return (window as typeof window & {
            __hapiShareTest: { active: boolean; fileType: string; fileName: string }
        }).__hapiShareTest
    })
    expect(result.active).toBe(true)
    expect(result.fileType).toBe('image/png')
    expect(result.fileName).toMatch(/^HAPI-Complex HAPI turn-\d{14}\.png$/)
})
