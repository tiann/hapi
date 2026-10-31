import { expect, test, type Page } from '@playwright/test'

const fixture = '/e2e-fixtures/project-expansion-fixture.html'
const header = (page: Page) => page.locator('[title="/work/project"]')
const panel = (page: Page) => header(page).locator('xpath=following-sibling::*[1]')
const saved = (page: Page) => page.evaluate(() => Object.fromEntries(
    Object.entries(localStorage).filter(([key]) => key.startsWith('hapi.projectGroupCollapse.v1.')),
))

for (const viewport of [{ width: 1280, height: 900 }, { width: 393, height: 852 }]) {
    test.describe(`project preference at ${viewport.width}px`, () => {
        test.use({ viewport })

        test('restores manual choices after reload, remount and browser-context reopen', async ({ page, browser }) => {
            await page.goto(fixture)
            await expect(panel(page)).not.toHaveAttribute('data-open')
            await header(page).click()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
            await page.reload()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
            await page.getByRole('button', { name: 'Toggle list', exact: true }).click()
            await page.getByRole('button', { name: 'Toggle list', exact: true }).click()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')

            // Recreate the browser context with only its saved local storage.
            const context = await browser.newContext({ storageState: await page.context().storageState(), viewport })
            try {
                const reopened = await context.newPage()
                await reopened.goto(new URL(fixture, page.url()).toString())
                await expect(panel(reopened)).toHaveAttribute('data-open', 'true')
                await header(reopened).click()
                await reopened.reload()
                await expect(panel(reopened)).not.toHaveAttribute('data-open')
            } finally { await context.close() }
        })

        test('search and selected-session reveal do not replace the saved manual collapse', async ({ page }) => {
            await page.goto(fixture)
            await header(page).click()
            await header(page).click()
            const before = await saved(page)
            await page.getByRole('button', { name: /^Search sessions/ }).click()
            const input = page.getByPlaceholder('Search title/path/Agent/machine/ID…')
            await input.fill('Archived task')
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
            await input.fill('no-matches')
            await expect(header(page)).toHaveCount(0)
            await input.fill('')
            await expect(panel(page)).not.toHaveAttribute('data-open')
            await page.getByRole('button', { name: 'Reveal archived', exact: true }).click()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
            expect(await saved(page)).toEqual(before)
            await header(page).click()
            await page.getByRole('button', { name: 'Live update', exact: true }).click()
            await expect(panel(page)).not.toHaveAttribute('data-open')
            await page.reload()
            await expect(panel(page)).not.toHaveAttribute('data-open')
        })

        test('isolates Hub, namespace and machine and survives absent project data', async ({ page }) => {
            await page.goto(fixture)
            await header(page).click()
            for (const suffix of ['?hub=https://other.test', '?namespace=tenant', '?machine=machine-b']) {
                await page.goto(fixture + suffix)
                await expect(panel(page)).not.toHaveAttribute('data-open')
            }
            await page.goto(fixture)
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
            await page.getByRole('button', { name: 'Toggle data', exact: true }).click()
            await page.getByRole('button', { name: 'Toggle data', exact: true }).click()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
        })

        test('keeps defaults for untouched groups and never saves an automatic expansion', async ({ page }) => {
            await page.goto(fixture)
            await page.getByRole('button', { name: 'Reveal archived', exact: true }).click()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
            expect(await saved(page)).toEqual({})
            await page.reload()
            await expect(panel(page)).not.toHaveAttribute('data-open')
        })

        test('search-time header clicks cannot silently replace a saved expansion', async ({ page }) => {
            await page.goto(fixture)
            await header(page).click()
            const before = await saved(page)
            await page.getByRole('button', { name: /^Search sessions/ }).click()
            const input = page.getByPlaceholder('Search title/path/Agent/machine/ID…')
            await input.fill('Archived task')
            await header(page).click()
            await page.getByRole('button', { name: 'Clear search', exact: true }).click()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
            expect(await saved(page)).toEqual(before)
            await page.reload()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
        })

        test('continues working with unavailable local storage', async ({ page }) => {
            await page.addInitScript(() => {
                const original = Storage.prototype.setItem
                Storage.prototype.setItem = function(key, value) {
                    if (key.startsWith('hapi.projectGroupCollapse.v1.')) throw new DOMException('Full', 'QuotaExceededError')
                    original.call(this, key, value)
                }
            })
            await page.goto(fixture)
            await header(page).click()
            await expect(panel(page)).toHaveAttribute('data-open', 'true')
            await header(page).click()
            await expect(panel(page)).not.toHaveAttribute('data-open')
        })

        test('keeps a selected project collapsed after search hides and restores it', async ({ page }) => {
            await page.goto(fixture)
            await page.getByRole('button', { name: 'Reveal archived', exact: true }).click()
            await header(page).click()
            const before = await saved(page)
            await page.getByRole('button', { name: /^Search sessions/ }).click()
            const input = page.getByPlaceholder('Search title/path/Agent/machine/ID…')
            await input.fill('no-matches')
            await expect(header(page)).toHaveCount(0)
            await input.fill('')
            await expect(panel(page)).not.toHaveAttribute('data-open')
            expect(await saved(page)).toEqual(before)
        })
    })
}
