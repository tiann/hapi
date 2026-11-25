import { expect, test } from '@playwright/test'
import { installHapiAuth } from './helpers/hapi-live'

// Supply a seeded session named "Image preview Back regression" containing image
// attachments. Never fall back to a default Hub URL, credentials or production data.
test.skip(process.env.HAPI_LIVE !== '1', 'Run through the task Live wrapper')

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test.describe(`live image preview Back at ${viewport.width}px`, () => {
        test.use({ viewport })
        test('dismisses the preview before leaving the conversation', async ({ page }) => {
            const baseUrl = process.env.HAPI_URL
            const accessToken = process.env.HAPI_ACCESS_TOKEN
            const sessionId = process.env.SESSION_ID
            if (!baseUrl || !accessToken || !sessionId) {
                throw new Error('HAPI_URL, HAPI_ACCESS_TOKEN and SESSION_ID are required')
            }
            await installHapiAuth(page, baseUrl, accessToken)
            await page.goto(`${baseUrl}/sessions`)
            const group = page.locator('[class~="group/project"]').first()
            await expect(group).toBeVisible()
            const sessionRow = page.getByRole('button', { name: /Image preview Back regression/ }).first()
            if (!await sessionRow.isVisible()) {
                await group.click()
            }
            await expect(sessionRow).toBeVisible()
            await sessionRow.click()
            await expect(page).toHaveURL(`${baseUrl}/sessions/${sessionId}`)
            const trigger = page.locator('[data-image-preview-trigger]').first()
            await expect(trigger).toBeVisible()
            const imageLabel = await trigger.getAttribute('data-image-preview-label')
            if (!imageLabel) throw new Error('Expected a labeled image preview')
            const preview = page.getByRole('dialog', { name: imageLabel, exact: true })
            await trigger.click()
            await expect(preview).toBeVisible()
            await page.goBack()
            await expect(preview).toBeHidden()
            await expect(page).toHaveURL(`${baseUrl}/sessions/${sessionId}`)
            await expect(trigger).toBeVisible()
            await trigger.click()
            await expect(preview).toBeVisible()
            await preview.getByRole('button', { name: 'Close', exact: true }).click()
            await expect(preview).toBeHidden()
            await page.goBack()
            await expect(page).toHaveURL(`${baseUrl}/sessions`)
        })
    })
}
