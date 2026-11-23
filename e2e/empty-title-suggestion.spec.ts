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

    await page.getByRole('button', { name: '展开错误详情' }).click()
    await expect(page.getByTestId('title-suggestion-diagnostics')).toContainText('HTTP 422')

    const screenshotPath = process.env.EMPTY_TITLE_SUGGESTION_SCREENSHOT_PATH
    if (screenshotPath) {
        await page.screenshot({ path: screenshotPath, fullPage: true })
    }
})

test('a failed save does not display the previous generation error details', async ({ page }) => {
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&saveFails=1')
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.getByRole('button', { name: 'Show error details' }).click()
    await expect(page.getByTestId('title-suggestion-diagnostics')).toBeVisible()
    await page.getByRole('textbox').fill('Manual title')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText(/failed to rename|rename failed/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Show error details' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Hide error details' })).toHaveCount(0)
    await expect(page.getByTestId('title-suggestion-diagnostics')).toHaveCount(0)
    if (process.env.HAPI_REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.HAPI_REVIEW_SCREENSHOT })
})

test('an unrelated pending session action disables Save without showing Saving', async ({ page }) => {
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&archivePending=1')

    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Saving/ })).toHaveCount(0)
    const screenshot = process.env.HAPI_RENAME_PENDING_SCREENSHOT
    if (screenshot) await page.screenshot({ path: screenshot })
})


test('a generated draft reports a stale manual title without discarding the draft', async ({ page }) => {
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&concurrentTitle=1')
    await expect(page.getByRole('textbox')).toHaveValue('Original title')
    await page.getByRole('button', { name: 'Generate' }).click()
    await expect(page.getByRole('textbox')).toHaveValue('Generated draft')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('The session title changed elsewhere.', { exact: false })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveValue('Generated draft')
    const screenshot = process.env.HAPI_RENAME_CONFLICT_SCREENSHOT
    if (screenshot) await page.screenshot({ path: screenshot })
})


for (const status of [502, 422]) {
    test(`title generation diagnostics do not expose an unrecognized proxy response (HTTP ${status})`, async ({ page }) => {
        await page.route('**/api/sessions/fixture-title/title-suggestion', route => route.fulfill({
            status,
            contentType: 'text/html',
            body: '<html><p>Proxy fixture internal backend note</p></html>'
        }))
        await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&apiResponse=1')
        await page.getByRole('button', { name: 'Generate' }).click()
        await expect(page.getByText('Failed to generate a title. Please try again.', { exact: true })).toBeVisible()
        await page.getByRole('button', { name: 'Show error details' }).click()
        await expect(page.getByTestId('title-suggestion-diagnostics')).toHaveText(`HTTP ${status}`)
        await expect(page.getByRole('dialog')).not.toContainText('Proxy fixture internal backend note')
        const screenshot = status === 422
            ? process.env.HAPI_TITLE_DIAGNOSTICS_PROXY_422_SCREENSHOT
            : process.env.HAPI_TITLE_DIAGNOSTICS_PROXY_SCREENSHOT
        if (screenshot) await page.screenshot({ path: screenshot })
    })
}

test('title generation diagnostics preserve only validated fields for a known provider error', async ({ page }) => {
    await page.route('**/api/sessions/fixture-title/title-suggestion', route => route.fulfill({
        status: 502,
        json: {
            code: 'provider',
            reason: 'rate-limited',
            providerStatus: 429,
            error: 'Internal provider detail from the fixture',
            debug: 'Unexpected debug field from the fixture'
        }
    }))
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&apiResponse=1')
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.getByRole('button', { name: 'Show error details' }).click()
    await expect(page.getByTestId('title-suggestion-diagnostics')).toHaveText(
        'HTTP 502 Error code: provider Provider HTTP 429 Provider reason: rate-limited'
    )
    await expect(page.getByRole('dialog')).not.toContainText(/internal provider detail|unexpected debug field/i)
    const screenshot = process.env.HAPI_TITLE_DIAGNOSTICS_PROVIDER_SCREENSHOT
    if (screenshot) await page.screenshot({ path: screenshot })
})

test('JSON with an unknown error code cannot add diagnostic fields', async ({ page }) => {
    await page.route('**/api/sessions/fixture-title/title-suggestion', route => route.fulfill({
        status: 503,
        json: { code: 'proxy-internal', reason: 'rate-limited', providerStatus: 429, error: 'Arbitrary proxy fixture note' }
    }))
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&apiResponse=1')
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.getByRole('button', { name: 'Show error details' }).click()
    await expect(page.getByTestId('title-suggestion-diagnostics')).toHaveText('HTTP 503')
    await expect(page.getByRole('dialog')).not.toContainText(/proxy-internal|rate-limited|429|arbitrary proxy fixture note/i)
})
