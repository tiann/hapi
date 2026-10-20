import { test, expect } from '@playwright/test'

for (const width of [390, 1280]) {
    test(`Reserve uses the existing model menu, with no automatic switch (${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 })
        await page.goto('/e2e-fixtures/luna-reserve-fixture.html')
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await expect(page.getByRole('button', { name: /Luna Reserve/ })).toHaveCount(0)
        await page.keyboard.press('Escape')
        await page.getByRole('button', { name: 'Toggle eligibility' }).click()
        await expect(page.getByTestId('model')).toHaveText('gpt-6-astra')
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: /Luna Reserve/ }).click()
        await expect(page.getByTestId('model')).toHaveText('gpt-6-astra')
        await page.getByRole('button', { name: 'Confirm native settings' }).click()
        await expect(page.getByTestId('model')).toHaveText('☾ Luna Reserve')
        await expect(page.getByTestId('sends')).toHaveText('0')
        await page.getByRole('button', { name: 'Codex usage details' }).click()
        await expect(page.getByText('Ordinary usage', { exact: true })).toBeVisible()
        await expect(page.getByText(/27% remaining/)).toBeVisible()
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })
}

for (const width of [390, 1280]) {
    test(`usage details stay above the expanded editor (${width}px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 })
        await page.goto('/e2e-fixtures/luna-reserve-fixture.html')
        await page.getByRole('button', { name: 'Toggle eligibility' }).click()
        await page.getByRole('button', { name: 'Settings', exact: true }).click()
        await page.getByRole('button', { name: /Luna Reserve/ }).click()
        await page.getByRole('button', { name: 'Confirm native settings' }).click()
        await page.getByRole('button', { name: 'Expand message editor' }).click()
        await page.getByRole('button', { name: 'Codex usage details' }).click()

        const details = page.getByRole('dialog').filter({ hasText: 'Ordinary usage' })
        await expect(details.getByText('Ordinary usage', { exact: true })).toBeVisible()
        await expect(details.getByText(/27% remaining/)).toBeVisible()
        await expect.poll(() => details.evaluate(element => {
            const bounds = element.getBoundingClientRect()
            const top = document.elementFromPoint(
                bounds.left + bounds.width / 2,
                bounds.top + bounds.height / 2,
            )
            return top !== null && element.contains(top)
        })).toBe(true)
        await expect(page.getByTestId('sends')).toHaveText('0')
    })
}
