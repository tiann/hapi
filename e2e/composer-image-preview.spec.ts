import { expect, test } from '@playwright/test'

const fixtureUrl = '/e2e-fixtures/composer-image-preview-fixture.html'
const attachment = (name: string) => `[data-hapi-composer-attachment-id="${name}"]`

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    test.describe(`composer image preview at ${viewport.width}px`, () => {
        test.use({ viewport })
        test.beforeEach(async ({ page }) => {
            await page.goto(fixtureUrl)
            await expect(page.locator(attachment('second.png'))).toBeVisible()
        })

        test('retains active image, zoom and draft across repeated status updates', async ({ page }) => {
            await page.getByRole('textbox', { name: 'Draft' }).fill('draft stays intact')
            await page.locator(attachment('first.png')).getByTitle('Click to zoom').click()
            const dialog = page.getByRole('dialog')
            await dialog.getByRole('button', { name: 'Next image' }).click()
            await dialog.getByTitle('Zoom in', { exact: true }).click()
            const ticks = Number(await page.getByTestId('refresh-count').textContent())
            await expect.poll(async () => Number(await page.getByTestId('refresh-count').textContent())).toBeGreaterThan(ticks + 10)
            await expect(page.getByRole('dialog', { name: 'second.png' })).toBeVisible()
            await expect(dialog.getByTitle('Reset zoom')).toHaveText('125%')
            await dialog.getByTitle('Close', { exact: true }).click()
            await expect(dialog).toBeHidden()
            await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('draft stays intact')
        })

        test('retains preview while drag controls change and clears removed attachments', async ({ page }) => {
            await page.locator(attachment('first.png')).getByTitle('Click to zoom').click()
            await page.evaluate(() => window.__composerImagePreview!.setDisabled(true))
            await expect(page.getByRole('dialog', { name: 'first.png' })).toBeVisible()
            await expect(page.getByRole('button', { name: 'Reorder attachment first.png' })).toHaveCount(0)
            await page.evaluate(() => window.__composerImagePreview!.setDisabled(false))
            await expect(page.getByRole('button', { name: 'Reorder attachment first.png' })).toHaveCount(1)
            await expect(page.getByRole('dialog', { name: 'first.png' })).toBeVisible()
            await page.evaluate(() => window.__composerImagePreview!.clearAttachments())
            await expect(page.getByRole('dialog')).toBeHidden()
            await expect(page.locator('[data-hapi-composer-attachment-id]')).toHaveCount(0)
        })

        test('keeps keyboard and pointer reordering, removal and explicit closing functional', async ({ page }) => {
            const first = page.locator(attachment('first.png'))
            await first.getByRole('button', { name: 'Reorder attachment first.png' }).press('ArrowRight')
            await expect(page.locator('[data-hapi-composer-attachment-id]').first()).toHaveAttribute('data-hapi-composer-attachment-id', 'second.png')
            const handle = await first.getByRole('button', { name: 'Reorder attachment first.png' }).boundingBox()
            const target = await page.locator(attachment('second.png')).boundingBox()
            await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2)
            await page.mouse.down()
            await page.mouse.move(target!.x + 5, target!.y + target!.height / 2, { steps: 8 })
            await page.mouse.up()
            await expect(page.locator('[data-hapi-composer-attachment-id]').first()).toHaveAttribute('data-hapi-composer-attachment-id', 'first.png')
            await expect(page.getByRole('dialog')).toBeHidden()
            await page.locator(attachment('second.png')).getByTitle('Click to zoom').click()
            await page.keyboard.press('Escape')
            await expect(page.getByRole('dialog')).toBeHidden()
            await page.locator(attachment('second.png')).getByRole('button', { name: 'Remove attachment' }).click()
            await expect(page.locator(attachment('second.png'))).toHaveCount(0)
        })

        test('preserves sent-image preview on parent refresh and closes only on a backdrop click', async ({ page }) => {
            await page.getByRole('region', { name: 'Sent images' }).getByTitle('Click to zoom').click()
            const dialog = page.getByRole('dialog', { name: 'sent.png' })
            await dialog.getByRole('img', { name: 'sent.png' }).click()
            const ticks = Number(await page.getByTestId('refresh-count').textContent())
            await expect.poll(async () => Number(await page.getByTestId('refresh-count').textContent())).toBeGreaterThan(ticks + 5)
            await expect(dialog).toBeVisible()
            await dialog.locator('div').last().click({ position: { x: 5, y: 5 } })
            await expect(dialog).toBeHidden()
        })
    })
}
