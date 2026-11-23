import { expect, test } from '@playwright/test'

test('title guidance says when no recent conversation text is available', async ({ page }) => {
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=zh-CN')

    await page.getByRole('button', { name: '生成' }).click()

    await expect(page.getByText(
        '没有可用于生成标题的近期对话文本，请先发送一条消息再试。'
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


test('a generated draft retains the original lock precondition when another tab locks the title', async ({ page }) => {
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&concurrentTitleLock=1')
    await page.getByRole('button', { name: 'Generate' }).click()
    await expect(page.getByRole('textbox')).toHaveValue('Generated draft')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByText('The session title changed elsewhere.', { exact: false })).toBeVisible()
    await expect(page.getByRole('textbox')).toHaveValue('Generated draft')
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


for (const error of ['unavailable', 'empty']) {
    test(`proxy JSON with error=${error} does not select Hub-specific guidance`, async ({ page }) => {
        await page.route('**/api/sessions/fixture-title/title-suggestion', route => route.fulfill({
            status: 503,
            json: { error }
        }))
        await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&apiResponse=1')
        await page.getByRole('button', { name: 'Generate' }).click()
        await expect(page.getByText('Failed to generate a title. Please try again.', { exact: true })).toBeVisible()
        await page.getByRole('button', { name: 'Show error details' }).click()
        await expect(page.getByTestId('title-suggestion-diagnostics')).toHaveText('HTTP 503')
        const screenshot = process.env.HAPI_TITLE_DIAGNOSTICS_GENERIC_JSON_SCREENSHOT
        if (error === 'unavailable' && screenshot) await page.screenshot({ path: screenshot })
    })
}


test('all Russian rename actions fit on a 320px viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 600 })
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=ru')
    const dialog = page.getByRole('dialog')
    const generate = dialog.getByRole('button', { name: 'Сгенерировать' })
    const cancel = dialog.getByRole('button', { name: 'Отмена', exact: true })
    const save = dialog.getByRole('button', { name: 'Сохранить', exact: true })
    await expect(save).toBeInViewport({ ratio: 1 })
    const bounds = await dialog.boundingBox()
    const [generateBounds, cancelBounds, saveBounds] = await Promise.all([generate.boundingBox(), cancel.boundingBox(), save.boundingBox()])
    expect(bounds).not.toBeNull()
    for (const button of [generateBounds, cancelBounds, saveBounds]) {
        expect(button).not.toBeNull()
        expect(button!.x).toBeGreaterThanOrEqual(bounds!.x)
        expect(button!.x + button!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
    }
    expect(cancelBounds!.y).toBe(saveBounds!.y)
    const screenshot = process.env.HAPI_RENAME_NARROW_RUSSIAN_SCREENSHOT
    if (screenshot) await page.screenshot({ path: screenshot })
})


test('expanded setup guidance remains scrollable on a short landscape viewport', async ({ page }) => {
    await page.setViewportSize({ width: 568, height: 320 })
    await page.route('**/api/sessions/fixture-title/title-suggestion', route => route.fulfill({
        status: 503,
        json: { code: 'unavailable' }
    }))
    await page.goto('/e2e-fixtures/rename-session-error-fixture.html?locale=en&apiResponse=1')
    await page.getByRole('button', { name: 'Generate' }).click()
    await page.getByRole('button', { name: 'Show error details' }).click()
    await expect(page.getByTestId('title-suggestion-diagnostics')).toHaveText('HTTP 503 Error code: unavailable')
    const dialog = page.getByRole('dialog')
    const bounds = await dialog.boundingBox()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(320)
    const screenshot = process.env.HAPI_RENAME_LANDSCAPE_SCREENSHOT
    const save = page.getByRole('button', { name: 'Save', exact: true })
    await save.scrollIntoViewIfNeeded()
    await expect(save).toBeInViewport({ ratio: 1 })
    if (screenshot) await page.screenshot({ path: screenshot })
    await dialog.evaluate(element => { element.scrollTop = 0 })
    await expect(page.getByRole('button', { name: 'Close' })).toBeInViewport({ ratio: 1 })
})
