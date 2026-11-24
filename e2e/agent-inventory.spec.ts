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


test('Agent details can list a custom project /agent command', async ({ page }) => {
    await page.goto('/e2e-fixtures/agent-inventory-fixture.html?provider=codex&customAgent=1')
    await page.getByRole('button', { name: 'Open agent details' }).click()
    const details = page.getByRole('dialog', { name: 'Agent details' })
    await expect(details.getByText('/agent', { exact: true })).toBeVisible()
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await details.screenshot({ path: `${screenshots}/agent-inventory-custom-agent.png` })
})


test('Agent details shows no skill or tool section for an empty live Claude inventory', async ({ page }) => {
    await page.goto('/e2e-fixtures/agent-inventory-fixture.html?provider=claude&emptyRuntime=1')
    await page.getByRole('button', { name: 'Open agent details' }).click()
    const details = page.getByRole('dialog', { name: 'Agent details' })
    await expect(details.getByText('/compact', { exact: true })).toBeVisible()
    await expect(details.getByRole('heading', { name: /skills|tools/i })).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await details.screenshot({ path: `${screenshots}/agent-inventory-claude-empty.png` })
})


test('the status bar uses the saved Codex usage window, not the configured model estimate', async ({ page }) => {
    await page.goto('/e2e-fixtures/agent-inventory-fixture.html?provider=codex&savedUsage=1')
    const status = page.getByTestId('saved-codex-usage')
    await expect(status.getByRole('button', { name: 'Context details', exact: true })).toContainText('40%')
    await expect(status.getByRole('button', { name: 'Context details', exact: true })).toContainText('80k / 200k')
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await status.screenshot({ path: `${screenshots}/agent-inventory-saved-window.png` })
})


test('known MCP server names remain visible when scoped discovery is unavailable', async ({ page }) => {
    await page.goto('/e2e-fixtures/agent-inventory-fixture.html?provider=codex&knownNamesOnly=1')
    await page.getByRole('button', { name: 'Open agent details' }).click()
    const dialog = page.getByRole('dialog', { name: 'Agent details' })
    await expect(dialog.getByText('docs', { exact: true })).toBeVisible()
    await expect(dialog.getByText('unavailable', { exact: true })).toHaveCount(0)
    const screenshots = process.env.HAPI_REVIEW_SCREENSHOT_DIR
    if (screenshots) await dialog.screenshot({ path: `${screenshots}/agent-inventory-known-mcp-names.png` })
})
