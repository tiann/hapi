import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })
test('branches a selected user turn with a different harness/model and recovers a lost response', async ({ page }) => {
    const submissions: Record<string, unknown>[] = []
    await page.route(url => url.pathname.startsWith('/api/'), async route => {
        const path = new URL(route.request().url()).pathname
        if (path.endsWith('/claude-models')) {
            await route.fulfill({ json: { success: true, availableModels: [{ value: 'opus-test', displayName: 'Opus test' }] } })
        } else if (path.endsWith('/codex-models')) {
            await route.fulfill({ json: { success: true, models: [{ id: 'codex-test', displayName: 'Codex test' }] } })
        } else if (path.endsWith('/branch')) {
            submissions.push(route.request().postDataJSON())
            if (submissions.length === 1) await route.fulfill({ status: 504, json: { error: 'Response lost' } })
            else await route.fulfill({ json: { sessionId: 'child' } })
        } else throw new Error(`Unexpected branch fixture request: ${path}`)
    })
    await page.goto('/e2e-fixtures/branch-conversation-fixture.html')
    await expect(page.getByRole('option', { name: 'Opus test' })).toBeAttached()
    await page.getByLabel('Harness').selectOption('codex')
    await expect(page.getByRole('option', { name: 'Codex test' })).toBeAttached()
    await page.getByLabel('Model', { exact: true }).selectOption('codex-test')
    await page.getByLabel('Keep history').selectOption('after')
    await page.getByLabel('Workspace').selectOption('worktree')
    await page.getByLabel('First instruction in the new branch').fill('Compare another implementation')
    await page.getByRole('button', { name: 'Create branch' }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await page.getByRole('button', { name: 'Create branch' }).click()
    await expect(page.getByTestId('child-session')).toHaveText('child')
    expect(submissions).toHaveLength(2)
    expect(submissions[0]).toEqual(submissions[1])
    expect(submissions[0]).toMatchObject({ agent: 'codex', model: 'codex-test', boundary: 'after', workspace: 'worktree',
        messageLocalId: 'user-turn-two', instruction: 'Compare another implementation' })
})
