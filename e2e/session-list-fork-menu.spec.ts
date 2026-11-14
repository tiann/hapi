import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

test.use({ serviceWorkers: 'block' })

test('forks an active session from the mobile list menu immediately after Copy reference', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/session-list-fork-menu-fixture.html?lang=zh-CN', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /可分叉会话/ }).click({ button: 'right' })

    const menu = page.getByRole('menu')
    const labels = await menu.getByRole('menuitem').allTextContents()
    expect(labels.indexOf('复制引用') + 1).toBe(labels.indexOf('分叉会话'))

    const runtime = process.env.HAPI_TASK_RUNTIME
    if (runtime) {
        const directory = join(runtime, 'screenshots')
        await mkdir(directory, { recursive: true })
        await page.screenshot({ path: join(directory, 'session-list-fork-menu.png') })
    }

    await menu.getByRole('menuitem', { name: '分叉会话' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: '分叉会话' })).toBeVisible()
    await expect(dialog).toContainText('从最新完成进度创建新会话？')

    if (runtime) {
        await page.screenshot({ path: join(runtime, 'screenshots', 'session-list-fork-confirm.png') })
    }

    const confirm = dialog.getByRole('button', { name: '确定' })
    await expect(confirm).toHaveClass(/bg-red-600/)
    await confirm.click()
    await expect(page.getByTestId('selected-session')).toHaveText('fork-child')
    await expect(page.locator('body')).toHaveAttribute('data-fork-source', 'forkable-source')
    await expect(dialog).toHaveCount(0)
})

test('keeps the list-menu fork action disabled while the source turn is running', async ({ page }) => {
    await page.goto('/e2e-fixtures/session-list-fork-menu-fixture.html?lang=zh-CN', { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: /运行中会话/ }).click({ button: 'right' })

    const item = page.getByRole('menuitem', { name: '分叉会话' })
    await expect(item).toHaveAttribute('aria-disabled', 'true')
    await item.dispatchEvent('click')
    await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('forks an archived Codex session directly from the mobile list menu', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/e2e-fixtures/session-list-fork-menu-fixture.html?lang=zh-CN', { waitUntil: 'domcontentloaded' })
    await page.getByTitle('/work/archived').first().click()
    await page.getByRole('button', { name: /已归档会话/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '分叉会话' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: '分叉会话' })).toBeVisible()
    await dialog.getByRole('button', { name: '确定' }).click()
    await expect(page.getByTestId('selected-session')).toHaveText('fork-child')
    await expect(page.locator('body')).toHaveAttribute('data-fork-source', 'archived-source')
})

test('forks the latest completed prefix from a running list row and disables an empty first turn', async ({ page }) => {
    await page.setViewportSize({ width: 393, height: 844 })
    await page.goto('/e2e-fixtures/session-list-fork-menu-fixture.html?lang=zh-CN')
    await page.getByRole('button', { name: /运行中已有历史/ }).click({ button: 'right' })
    const action = page.getByRole('menuitem', { name: '分叉会话', exact: true })
    await expect(action).not.toHaveAttribute('aria-disabled', 'true')
    const runtime = process.env.HAPI_TASK_RUNTIME
    if (runtime) { await mkdir(join(runtime, 'screenshots'), { recursive: true }); await page.screenshot({ path: join(runtime, 'screenshots', 'running-fork-menu.png') }) }
    await action.click()
    await expect(page.getByRole('dialog')).toContainText('最后一个已完成轮次')
    if (runtime) await page.screenshot({ path: join(runtime, 'screenshots', 'running-fork-confirm.png') })
    await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click()
    await expect(page.locator('body')).toHaveAttribute('data-latest-completed', 'true')
    await page.getByRole('button', { name: /首轮运行中/ }).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: '分叉会话', exact: true })).toHaveAttribute('aria-disabled', 'true')
    await expect(page.getByText('暂无已完成轮次可分叉。', { exact: true })).toBeAttached()
})
