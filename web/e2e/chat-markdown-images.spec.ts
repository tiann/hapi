import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

async function capture(page: import('@playwright/test').Page, fileName: string) {
    const directory = process.env.HAPI_SCREENSHOT_DIR
    if (!directory) return
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, fileName), fullPage: true })
}

test('renders and previews local and remote chat Markdown images', async ({ page }) => {
    await page.goto('/e2e-fixtures/chat-markdown-images.html')

    const localImage = page.locator('img[alt="Local chart"]')
    await expect(localImage).toHaveCount(1)
    await expect(localImage).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
    const localTrigger = page.getByRole('button', { name: /Local chart/i })
    await expect(localTrigger).toBeEnabled()
    await expect(localTrigger.locator('xpath=ancestor::a')).toHaveCount(0)
    await capture(page, 'markdown-image-inline.png')

    await localTrigger.click()
    const localDialog = page.getByRole('dialog', { name: 'Local chart' })
    await expect(localDialog).toBeVisible()
    await expect(localDialog.getByRole('img', { name: 'Local chart' }))
        .toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
    await capture(page, 'markdown-image-fullscreen.png')
    await localDialog.getByTitle('Close', { exact: true }).click()
    await expect(localTrigger).toBeFocused()

    const remoteImage = page.locator('img[alt="Remote chart"]')
    await expect(remoteImage).toHaveCount(1)
    await expect(remoteImage).toHaveAttribute('src', /\/favicon\.ico$/)
    await expect(remoteImage).toHaveAttribute('loading', 'lazy')
    await expect(remoteImage).toHaveAttribute('referrerpolicy', 'no-referrer')
    const remoteTrigger = page.getByRole('button', { name: /Remote chart/i })
    await expect(remoteTrigger).toBeEnabled()
    await remoteTrigger.click()
    await expect(page.getByRole('dialog', { name: 'Remote chart' })
        .getByRole('img', { name: 'Remote chart' }))
        .toHaveAttribute('referrerpolicy', 'no-referrer')
    await page.keyboard.press('Escape')
    await expect(remoteTrigger).toBeFocused()

    const blockedImage = page.locator('[data-hapi-markdown-image-fallback="true"][aria-label="Blocked chart"]')
    await expect(blockedImage).toHaveCount(1)
    await expect(page.getByRole('button', { name: /Blocked chart/i })).toHaveCount(0)
})

test('portals Markdown image previews above tool detail dialogs', async ({ page }) => {
    await page.goto('/e2e-fixtures/chat-markdown-images.html')
    await page.getByRole('button', { name: 'Open tool detail' }).click()
    const toolDialog = page.getByRole('dialog', { name: 'Tool detail' })
    await expect(toolDialog).toBeVisible()

    const trigger = toolDialog.getByRole('button', { name: /Dialog chart/i })
    await expect(trigger).toBeEnabled()
    await trigger.click()

    const preview = page.getByRole('dialog', { name: 'Dialog chart' })
    await expect(preview).toBeVisible()
    await expect(preview.getByTitle('Close', { exact: true })).toBeFocused()
    const viewport = page.viewportSize()
    const box = await preview.boundingBox()
    expect(viewport).not.toBeNull()
    expect(box).not.toBeNull()
    expect(box!.x).toBeCloseTo(0, 0)
    expect(box!.y).toBeCloseTo(0, 0)
    expect(box!.width).toBeCloseTo(viewport!.width, 0)
    expect(box!.height).toBeCloseTo(viewport!.height, 0)

    await preview.getByTitle('Zoom in', { exact: true }).click()
    await expect(preview).toBeVisible()
    await capture(page, 'markdown-image-tool-dialog.png')
    await preview.getByTitle('Close', { exact: true }).click()
    await expect(toolDialog).toBeVisible()
    await expect(trigger).toBeFocused()
})

test.describe('mobile Markdown image previews', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('opens Markdown image previews from a mobile viewport', async ({ page }) => {
        await page.goto('/e2e-fixtures/chat-markdown-images.html')
        const trigger = page.getByRole('button', { name: /Local chart/i })
        await expect(trigger).toBeEnabled()
        await trigger.tap()
        await expect(page.getByRole('dialog', { name: 'Local chart' })).toBeVisible()
        await capture(page, 'markdown-image-fullscreen-mobile.png')
    })
})
