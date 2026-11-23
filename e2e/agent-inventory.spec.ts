import { expect, test } from '@playwright/test'

for (const provider of ['codex', 'claude']) {
    test(`Agent details displays the published ${provider} inventory`, async ({ page }) => {
        await page.goto(`/e2e-fixtures/agent-inventory-fixture.html?provider=${provider}`)
        await page.getByRole('button', { name: 'Open agent details' }).click()
        const details = page.getByRole('dialog', { name: 'Agent details' })
        await expect(details.getByText('/compact', { exact: true })).toBeVisible()
        if (provider === 'codex') {
            await expect(details.getByText('runtime-only', { exact: true })).toBeVisible()
            await expect(details.getByText('disabled', { exact: true })).toBeVisible()
            await expect(details.getByText(/^\/(clear|new|agent)$/)).toHaveCount(0)
        } else {
            await expect(details.getByText('automatic-skill', { exact: true })).toBeVisible()
        }
        const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
        if (screenshots) await details.screenshot({ path: `${screenshots}/agent-inventory-review-${provider}.png` })
    })
}
