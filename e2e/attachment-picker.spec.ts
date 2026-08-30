import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 })

const fixtureUrl = '/e2e-fixtures/attachment-picker-fixture.html'
const toolbarFixtureUrl = `${fixtureUrl}?toolbar=1`

test.describe('composer attachment picker', () => {
    test('shows one HAPI-styled bottom panel with three source actions', async ({ page }, testInfo) => {
        await page.goto(toolbarFixtureUrl)
        await page.getByTestId('composer-attachment-picker-trigger').click()

        const dialog = page.getByRole('dialog', { name: 'Add attachment' })
        await expect(dialog).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Photos' })).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Camera' })).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Files' })).toBeVisible()
        await expect(dialog).toHaveClass(/rounded-t-/)
        await page.waitForTimeout(350)
        const box = await dialog.boundingBox()
        expect(box).not.toBeNull()
        expect(box!.y + box!.height).toBeLessThanOrEqual(844)
        await page.screenshot({ path: testInfo.outputPath('attachment-picker-mobile.png') })
    })

    test('routes each action to its native file chooser configuration', async ({ page }) => {
        await page.goto(toolbarFixtureUrl)

        const sources = [
            { action: 'Photos', input: 'composer-attachment-input-photos', multiple: true },
            { action: 'Camera', input: 'composer-attachment-input-camera', multiple: false },
            { action: 'Files', input: 'composer-attachment-input-files', multiple: true },
        ] as const

        for (const source of sources) {
            await page.getByTestId('composer-attachment-picker-trigger').click()
            const chooserPromise = page.waitForEvent('filechooser')
            await page.getByRole('button', { name: source.action }).click()
            const chooser = await chooserPromise

            expect(await chooser.isMultiple()).toBe(source.multiple)
            await expect(page.getByRole('dialog', { name: 'Add attachment' })).not.toBeVisible()
            await expect(page.getByTestId(source.input)).toHaveAttribute('type', 'file')
        }
    })

    test('forwards files selected by a native picker to the composer callback', async ({ page }) => {
        await page.goto(fixtureUrl)
        const chooserPromise = page.waitForEvent('filechooser')
        await page.getByTestId('composer-attachment-picker-trigger').click()
        await page.getByRole('button', { name: 'Photos' }).click()
        const chooser = await chooserPromise

        await chooser.setFiles([
            { name: 'first.png', mimeType: 'image/png', buffer: Buffer.from('first') },
            { name: 'second.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('second') },
        ])

        await expect.poll(() => page.evaluate(() => window.__attachmentPickerE2E?.selectedNames)).toEqual([
            'first.png',
            'second.jpg',
        ])
    })
})

test.describe('desktop composer attachment entrypoint', () => {
    test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

    test('keeps the original direct system file picker on wide viewports', async ({ page }) => {
        await page.goto(toolbarFixtureUrl)

        const trigger = page.getByRole('button', { name: 'Attach file' })
        await expect(trigger).toBeVisible()
        await expect(page.getByTestId('composer-attachment-picker-trigger')).toHaveCount(0)

        const chooserPromise = page.waitForEvent('filechooser')
        await trigger.click()
        await chooserPromise

        await expect(page.getByRole('dialog', { name: 'Add attachment' })).toHaveCount(0)
    })
})
