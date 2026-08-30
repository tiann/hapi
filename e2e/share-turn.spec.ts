import { expect, test } from '@playwright/test'
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
        agentIcon: false,
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

test('keeps the Agent icon independent from Agent text in the share preview', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi-session-header-metadata', JSON.stringify({
        showLabels: false,
        agent: false,
        agentIcon: true,
        model: false,
        reasoning: false,
        fastMode: false,
        machine: false,
        lastActive: false,
        createdAt: false,
        updatedAt: false,
        worktree: false,
    })))
    await page.goto('/e2e-fixtures/share-turn-fixture.html')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('share-turn-agent-icon')).toHaveCount(1)
    await expect(dialog.getByText('codex', { exact: true })).toHaveCount(0)
})

test('keeps code and image controls interactive in preview', async ({ page }, testInfo) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto('/e2e-fixtures/share-turn-fixture.html')
    await page.getByRole('button', { name: 'Open share preview' }).click()

    const dialog = page.getByRole('dialog', { name: 'Share turn as image' })
    const wrapButton = dialog.locator('[data-hapi-code-wrap-toggle="true"]').first()
    await expect(wrapButton).toHaveAttribute('aria-pressed', 'false')

    const unwrappedDownloadPromise = page.waitForEvent('download')
    await dialog.getByRole('button', { name: 'Download' }).click()
    const unwrappedDownload = await unwrappedDownloadPromise
    const unwrappedPath = testInfo.outputPath('interactive-unwrapped.png')
    await unwrappedDownload.saveAs(unwrappedPath)
    const unwrappedSize = pngSize(await readFile(unwrappedPath))

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
    expect(previewWidth).toBeLessThanOrEqual(720)
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
