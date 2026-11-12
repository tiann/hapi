import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getHapiBaseUrl, installHapiAuth, readCliAccessToken } from './helpers/hapi-live'

test.skip(process.env.HAPI_LIVE !== '1' || !process.env.HAPI_TASK_RUNTIME, 'Requires an isolated task Hub with filter acceptance seed data')
test('filters real Hub sessions by scratchlist using authenticated batch API', async ({ page, request }) => {
    const base = getHapiBaseUrl()
    const token = readCliAccessToken()
    await page.setViewportSize({ width: 393, height: 844 })
    await installHapiAuth(page, base, token)
    await page.addInitScript(() => {
        localStorage.setItem('hapi-lang', 'zh-CN')
        localStorage.setItem('hapi-session-list-status', 'archived')
    })
    await page.goto(base + '/sessions', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('button', { name: /筛选验证：包含草稿/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /筛选验证：没有草稿/ })).toBeVisible()
    await page.getByRole('button', { name: '排序与筛选', exact: true }).click()
    const response = page.waitForResponse(r => r.url().endsWith('/api/sessions/scratchlist-status') && r.request().method() === 'GET')
    await page.getByRole('menuitemcheckbox', { name: '草稿', exact: true }).click()
    expect((await response).status()).toBe(200)
    await expect(page.getByRole('button', { name: /筛选验证：包含草稿/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /筛选验证：没有草稿/ })).toHaveCount(0)
    const directory = join(process.env.HAPI_TASK_RUNTIME!, 'screenshots')
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, 'live-mobile-scratchlist-filter.png') })
    await page.keyboard.press('Escape')
    await page.screenshot({ path: join(directory, 'live-mobile-scratchlist-results.png') })
    await page.getByRole('button', { name: '排序与筛选', exact: true }).click()
    await page.getByRole('menuitem', { name: '恢复默认', exact: true }).click()
    await expect(page.getByRole('menuitemcheckbox', { name: '草稿', exact: true })).toHaveAttribute('aria-checked', 'false')
    await page.getByRole('menuitemradio', { name: '归档', exact: true }).click()
    await expect(page.getByRole('button', { name: /筛选验证：没有草稿/ })).toBeVisible()
    const unauthenticated = await request.get(base + '/api/sessions/scratchlist-status')
    expect(unauthenticated.status()).toBe(401)
})
