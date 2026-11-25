import { expect, test, type Locator, type Page } from '@playwright/test'

const items = (page: Page) => page.locator('[data-hapi-composer-attachment-id]')
const handles = (page: Page) => page.getByTestId('attachment-drag-handle')
const item = (page: Page, name: string) => page.locator(`[data-hapi-composer-attachment-id="${name}"]`)
test.use({ serviceWorkers: 'block' })

async function screenshot(page: Page, path: (name: string) => string, name: string) {
    const composer = page.getByRole('region', { name: 'Composer', exact: true })
    await composer.screenshot({ path: path(`${name}.png`) })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await composer.screenshot({ path: path(`${name}-dark.png`) })
    await page.evaluate(() => { delete document.documentElement.dataset.theme })
}

for (const touch of [false, true]) {
    test.describe(touch ? 'touch' : 'desktop', () => {
        test.use({ viewport: { width: touch ? 390 : 1000, height: 800 }, hasTouch: touch })
        const activate = (locator: Locator) => touch ? locator.tap() : locator.click()

        test.beforeEach(async ({ page }) => {
            await page.goto('/e2e-fixtures/composer-image-drag-fixture.html', { waitUntil: 'domcontentloaded' })
        })

        for (const [kind, name] of [['image', 'first.png'], ['file', 'notes.txt']] as const) {
            test(`single ${kind} has no drag handle and can still be removed`, async ({ page }, testInfo) => {
                await activate(page.getByRole('button', { name: `Add ${kind}`, exact: true }))
                const attachment = item(page, name)
                await expect(attachment).toBeVisible()
                await attachment.hover()
                await expect(handles(page)).toHaveCount(0)
                if (kind === 'file') {
                    const spacing = await attachment.evaluate((element) => {
                        const name = element.querySelector('span')!.getBoundingClientRect()
                        const removeIcon = element.querySelector('button svg')!.getBoundingClientRect()
                        const chip = element.getBoundingClientRect()
                        // The 12px icon's stroked X ends 2px inside its SVG viewport.
                        return { left: name.left - chip.left, right: chip.right - removeIcon.right + 2 }
                    })
                    expect(spacing.left).toBeCloseTo(spacing.right, 1)
                }
                const remove = attachment.getByRole('button', { name: 'Remove attachment' })
                await expect(remove).toHaveCSS('opacity', '1')
                await remove.focus()
                await expect(handles(page)).toHaveCount(0)
                await screenshot(page, (name) => testInfo.outputPath(name), `single-${kind}`)
                if (kind === 'image') {
                    await activate(attachment.getByTitle('Click to zoom'))
                    await expect(page.getByRole('dialog', { name })).toBeVisible()
                    await activate(page.getByRole('dialog').getByTitle('Close', { exact: true }))
                }
                await attachment.hover()
                await activate(remove)
                await expect(items(page)).toHaveCount(0)
            })
        }

        test('updates handles at 1 → 2 → 1, preserving the mixed order and draft', async ({ page }, testInfo) => {
            await activate(page.getByRole('button', { name: 'Add image', exact: true }))
            await expect(items(page)).toHaveCount(1)
            await expect(handles(page)).toHaveCount(0)
            await page.getByRole('textbox', { name: 'Draft' }).fill('Keep this draft')
            await activate(page.getByRole('button', { name: 'Add file', exact: true }))
            await expect(handles(page)).toHaveCount(2)
            await item(page, 'first.png').hover()
            await expect(item(page, 'first.png').getByTestId('attachment-drag-handle')).toHaveCSS('opacity', '1')
            await screenshot(page, (name) => testInfo.outputPath(name), 'mixed-attachments')
            await item(page, 'notes.txt').getByTestId('attachment-drag-handle').press('Home')
            await expect(items(page).first()).toHaveAttribute('data-hapi-composer-attachment-id', 'notes.txt')
            await item(page, 'first.png').hover()
            await activate(item(page, 'first.png').getByRole('button', { name: 'Remove attachment' }))
            await expect(handles(page)).toHaveCount(0)
            await expect(item(page, 'notes.txt')).toBeVisible()
            await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('Keep this draft')
        })

        test('two images retain their handles and hide them when one is removed', async ({ page }) => {
            await activate(page.getByRole('button', { name: 'Load attachments', exact: true }))
            await expect(items(page)).toHaveCount(3)
            await activate(item(page, 'notes.txt').getByRole('button', { name: 'Remove attachment' }))
            await expect(handles(page)).toHaveCount(2)
            await item(page, 'first.png').hover()
            await activate(item(page, 'first.png').getByRole('button', { name: 'Remove attachment' }))
            await expect(handles(page)).toHaveCount(0)
            await expect(item(page, 'second.png')).toBeVisible()
        })

        test('two files retain sorting and hide the remaining handle after deletion', async ({ page }) => {
            await activate(page.getByRole('button', { name: 'Add file', exact: true }))
            await activate(page.getByRole('button', { name: 'Add second file', exact: true }))
            await expect(handles(page)).toHaveCount(2)
            await item(page, 'other.txt').getByTestId('attachment-drag-handle').press('Home')
            await expect(items(page).first()).toHaveAttribute('data-hapi-composer-attachment-id', 'other.txt')
            await activate(item(page, 'other.txt').getByRole('button', { name: 'Remove attachment' }))
            await expect(handles(page)).toHaveCount(0)
            await expect(item(page, 'notes.txt')).toBeVisible()
        })
    })
}
