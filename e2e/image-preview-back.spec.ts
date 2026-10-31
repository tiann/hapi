import { expect, test, type Page } from '@playwright/test'

async function openConversation(page: Page) {
    await page.goto('/e2e-fixtures/image-preview-back-fixture.html')
    await page.getByRole('button', { name: 'Open conversation' }).click()
    await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible()
    await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('Keep this draft')
}

async function expectConversation(page: Page) {
    await expect(page).toHaveURL(/\/sessions\/one$/)
    await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue('Keep this draft')
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test.describe(`image preview Back at ${viewport.width}px`, () => {
        test.use({ viewport })
        test.beforeEach(async ({ page }) => openConversation(page))

        test('browser Back dismisses a sent image and preserves the conversation, draft and scroll', async ({ page }) => {
            const errors: string[] = []
            page.on('pageerror', (error) => errors.push(error.message))
            const trigger = page.getByRole('region', { name: 'Sent images' }).getByTitle('Click to zoom').first()
            await trigger.scrollIntoViewIfNeeded()
            const scrollTop = await page.getByTestId('conversation-scroll').evaluate((element) => element.scrollTop)
            await trigger.click()
            await expect(page.getByRole('dialog')).toBeVisible()
            await page.goBack()
            await expect(page.getByRole('dialog')).toBeHidden()
            await expectConversation(page)
            await expect.poll(() => page.getByTestId('conversation-scroll').evaluate((element) => element.scrollTop)).toBe(scrollTop)
            await page.goBack()
            await expect(page.getByRole('heading', { name: 'Session list' })).toBeVisible()
            expect(errors).toEqual([])
        })

        test('gallery changes and zoom still require just one Back to dismiss', async ({ page }) => {
            await page.getByRole('region', { name: 'Sent images' }).getByTitle('Click to zoom').first().click()
            await page.getByRole('button', { name: 'Next image' }).click()
            await page.getByTitle('Zoom in', { exact: true }).click()
            await expect(page.getByRole('dialog', { name: 'second.png' })).toBeVisible()
            await page.goBack()
            await expect(page.getByRole('dialog')).toBeHidden()
            await expectConversation(page)
            await page.goBack()
            await expect(page.getByRole('heading', { name: 'Session list' })).toBeVisible()
        })

        for (const dismissal of ['Close', 'Escape', 'backdrop'] as const) {
            test(`${dismissal} leaves no extra Back step after repeated opens`, async ({ page }) => {
                for (let attempt = 0; attempt < 2; attempt++) {
                    await page.getByRole('region', { name: 'Composer images' }).getByTitle('Click to zoom').click()
                    const dialog = page.getByRole('dialog')
                    await expect(dialog).toBeVisible()
                    if (dismissal === 'Close') await dialog.getByTitle('Close', { exact: true }).click()
                    else if (dismissal === 'Escape') await page.keyboard.press('Escape')
                    else await dialog.locator('img').locator('..').click({ position: { x: 5, y: 5 } })
                    await expect(dialog).toBeHidden()
                    await expectConversation(page)
                }
                await page.goBack()
                await expect(page.getByRole('heading', { name: 'Session list' })).toBeVisible()
            })
        }

        test('draft preview Back cleanup permits reopening and normal forward navigation', async ({ page }) => {
            const trigger = page.getByRole('region', { name: 'Composer images' }).getByTitle('Click to zoom')
            for (let attempt = 0; attempt < 2; attempt++) {
                await trigger.click()
                await expect(page.getByRole('dialog', { name: 'Draft image' })).toBeVisible()
                await page.evaluate(() => window.history.back())
                await expect(page.getByRole('dialog')).toBeHidden()
                await expectConversation(page)
            }
            await page.goBack()
            await expect(page.getByRole('heading', { name: 'Session list' })).toBeVisible()
            await page.goForward()
            await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible()
            await expect(page.getByRole('dialog')).toBeHidden()
            await page.goBack()
            await expect(page.getByRole('heading', { name: 'Session list' })).toBeVisible()
        })

        test('unmounting an open draft removes its navigation blocker', async ({ page }) => {
            await page.getByRole('region', { name: 'Composer images' }).getByTitle('Click to zoom').click()
            await expect(page.getByRole('dialog')).toBeVisible()
            await page.getByTestId('remove-draft').evaluate((element: HTMLButtonElement) => element.click())
            await expect(page.getByRole('dialog')).toBeHidden()
            await page.goBack()
            await expect(page.getByRole('heading', { name: 'Session list' })).toBeVisible()
        })

        test('an open preview allows route changes and leaves no blocker on remount', async ({ page }) => {
            await page.getByRole('region', { name: 'Composer images' }).getByTitle('Click to zoom').click()
            await expect(page.getByRole('dialog')).toBeVisible()
            // Simulate a background redirect while the modal covers navigation.
            await page.getByTestId('navigate-away').evaluate((element: HTMLButtonElement) => element.click())
            await expect(page.getByRole('heading', { name: 'Session list' })).toBeVisible()
            await expect(page.getByRole('dialog')).toBeHidden()
            await page.goBack()
            await expect(page.getByRole('heading', { name: 'Conversation', exact: true })).toBeVisible()
            await page.goBack()
            await expect(page.getByRole('heading', { name: 'Session list' })).toBeVisible()
        })
    })
}
