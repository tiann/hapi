import { expect, test } from '@playwright/test'

const fixtureUrl = '/e2e-fixtures/usage-query-tab-order-fixture.html'

test.use({ viewport: { width: 880, height: 1000 } })

test('keeps Tab and Shift+Tab in form order while the Template selector is open', async ({ page }) => {
    await page.goto(fixtureUrl)
    const trigger = page.getByRole('combobox', { name: 'Template' })
    const listbox = page.getByRole('listbox', { name: 'Template' })
    const editor = page.getByRole('textbox', { name: 'Usage query template JSON' })
    const previous = page.getByRole('checkbox', { name: 'Enable quota query' })

    await trigger.focus()
    await page.keyboard.press('ArrowDown')
    await expect(listbox).toBeVisible()
    await expect(trigger).toBeFocused()
    const highlighted = listbox.getByRole('option', { name: 'Generic rate-limit windows' })
    await expect(trigger).toHaveAttribute('aria-activedescendant', (await highlighted.getAttribute('id'))!)
    if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/usage-query-template-keyboard.png` })
    }
    await page.keyboard.press('Tab')
    await expect(editor).toBeFocused()
    await expect(listbox).toHaveCount(0)

    await page.keyboard.press('Shift+Tab')
    await expect(trigger).toBeFocused()
    await page.keyboard.press('Space')
    await expect(listbox).toBeVisible()
    await page.keyboard.press('Shift+Tab')
    await expect(previous).toBeFocused()
    await expect(listbox).toHaveCount(0)
})

test('removes the test preview when the JSON is edited', async ({ page }) => {
    await page.goto(fixtureUrl)
    const editor = page.getByRole('textbox', { name: 'Usage query template JSON' })
    await page.getByRole('button', { name: 'Test' }).click()
    await expect(page.getByText('42%')).toBeVisible()
    await editor.fill(`${await editor.inputValue()} `)
    await expect(page.getByText('Test result')).toHaveCount(0)
    if (process.env.HAPI_REVIEW_SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.HAPI_REVIEW_SCREENSHOT_DIR}/usage-query-preview-cleared.png` })
    }
})
