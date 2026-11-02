import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

for (const mobile of [false, true]) {
    test(`late command results retain identity, outcome and reliable timing (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
        test.setTimeout(120_000)
        await page.setViewportSize(mobile ? { width: 412, height: 915 } : { width: 1280, height: 1000 })
        await page.goto('/e2e-fixtures/late-codex-command-fixture.html', { timeout: 90_000, waitUntil: 'domcontentloaded' })
        const failed = page.getByTestId('failed')
        await expect(failed.getByText('node failed-server.js', { exact: false }).first()).toBeVisible()
        await expect(failed.locator('.text-red-600').first()).toBeVisible()
        await expect(failed.getByText('4h 37m', { exact: false }).first()).toBeVisible()
        await expect(failed.getByText('Started', { exact: true })).toHaveCount(0)
        const unknown = page.getByTestId('unknown')
        await expect(unknown.getByText('Started', { exact: true })).toHaveCount(0)
        await expect(unknown.getByText('Duration', { exact: true })).toHaveCount(0)
        await expect(unknown.getByText('0.0s', { exact: true })).toHaveCount(0)
        await expect(page.getByTestId('success').getByText('2.5s', { exact: true })).toBeVisible()
        const directory = process.env.HAPI_TASK_SCREENSHOTS ?? testInfo.outputDir
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: join(directory, `late-command-${mobile ? 'mobile' : 'desktop'}-${testInfo.project.name}.png`), fullPage: true })
        // Details use the same native duration and still expose the command output.
        await failed.getByRole('button').first().click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(page.getByRole('dialog').getByText('Started', { exact: true })).toHaveCount(0)
        await expect(page.getByRole('dialog').getByText('4h 37m', { exact: false }).first()).toBeVisible()
    })
}
