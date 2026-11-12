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
    await capture(page, 'markdown-image-inline.png')

    await localTrigger.click()
    const localDialog = page.getByRole('dialog', { name: 'Local chart' })
    await expect(localDialog).toBeVisible()
    await expect(localDialog.getByRole('img', { name: 'Local chart' }))
        .toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
    await capture(page, 'markdown-image-fullscreen.png')
    await localDialog.getByTitle('Close', { exact: true }).click()

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

    const blockedImage = page.locator('[data-hapi-markdown-image-fallback="true"][aria-label="Blocked chart"]')
    await expect(blockedImage).toHaveCount(1)
    await expect(page.getByRole('button', { name: /Blocked chart/i })).toHaveCount(0)
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
