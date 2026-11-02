import { expect, test } from '@playwright/test'

test('renders local chat Markdown images through the session API', async ({ page }) => {
    await page.goto('/e2e-fixtures/chat-markdown-images.html')

    const localImage = page.locator('img[alt="Local chart"]')
    await expect(localImage).toHaveCount(1)
    await expect(localImage).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)

    const remoteImage = page.locator('img[alt="Remote chart"]')
    await expect(remoteImage).toHaveCount(1)
    await expect(remoteImage).toHaveAttribute('src', 'https://example.com/chart.png')

    const blockedImage = page.locator('[data-hapi-markdown-image-fallback="true"][aria-label="Blocked chart"]')
    await expect(blockedImage).toHaveCount(1)
})
