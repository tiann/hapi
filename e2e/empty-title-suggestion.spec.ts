import { expect, test } from '@playwright/test'

test('empty sessions explain why title generation cannot run', async ({ page }) => {
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=zh-CN')

    await page.getByRole('button', { name: '生成' }).click()

    await expect(page.getByText(
        '此会话还没有对话内容，请先发送一条消息再生成标题。'
    )).toBeVisible()
    await expect(page.getByText('标题生成失败，请重试。')).not.toBeVisible()

    const collapsedScreenshotPath = process.env.EMPTY_TITLE_SUGGESTION_COLLAPSED_SCREENSHOT_PATH
    if (collapsedScreenshotPath) {
        await page.screenshot({ path: collapsedScreenshotPath, fullPage: true })
    }

    await page.getByRole('button', { name: '展开报错原文' }).click()
    await expect(page.getByTestId('title-suggestion-raw-error')).toContainText('HTTP 422')

    const screenshotPath = process.env.EMPTY_TITLE_SUGGESTION_SCREENSHOT_PATH
    if (screenshotPath) {
        await page.screenshot({ path: screenshotPath, fullPage: true })
    }
})

test('a failed save does not display the previous generation error details', async ({ page }) => {
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&saveFails=1')
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.getByRole('button', { name: 'Show original error' }).click()
    await expect(page.getByTestId('title-suggestion-raw-error')).toBeVisible()
    await page.getByRole('textbox').fill('Manual title')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/failed to rename|rename failed/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show original error' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hide original error' })).toHaveCount(0)
    await expect(page.getByTestId('title-suggestion-raw-error')).toHaveCount(0)
    if (process.env.HAPI_REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.HAPI_REVIEW_SCREENSHOT })
})

test('an unrelated pending session action disables Save without showing Saving', async ({ page }) => {
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&archivePending=1')

    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Saving/ })).toHaveCount(0)
    const screenshot = process.env.HAPI_RENAME_PENDING_SCREENSHOT
    if (screenshot) await page.screenshot({ path: screenshot })
})
