import { expect, test, type Page } from '@playwright/test'

const BASE_URL = process.env.HAPI_E2E_BASE_URL ?? 'http://127.0.0.1:3906'
const BASE_TOKEN = process.env.HAPI_E2E_CLI_TOKEN ?? 'pw-test-token'
const RUN_ID = process.env.HAPI_E2E_RUN_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function token(namespaceSuffix: string): string {
    return `${BASE_TOKEN}:session-metadata-${RUN_ID}-${namespaceSuffix}`
}

async function login(page: Page, accessToken: string): Promise<void> {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.getByPlaceholder('Access token').fill(accessToken)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await expect(page.getByPlaceholder('Access token')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.locator('.session-list-item').first()).toBeVisible({ timeout: 15_000 })
}

async function createCliSession(
    accessToken: string,
    tag: string,
    name: string,
    path: string,
    machineId: string
): Promise<string> {
    const response = await fetch(`${BASE_URL}/cli/sessions`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            tag,
            metadata: {
                name,
                path,
                host: 'pw-host',
                machineId,
                flavor: 'codex',
                worktree: {
                    basePath: '/work/repo',
                    branch: 'feature/chips',
                    name: 'feature-chips'
                }
            },
            agentState: null,
            model: 'gpt-5.4',
            effort: 'very-high'
        })
    })
    expect(response.status).toBe(200)
    const json = await response.json() as { session: { id: string } }
    return json.session.id
}

test('session metadata chips render in list and header', async ({ page }) => {
    const accessToken = token('chips')

    const activeSessionId = await createCliSession(accessToken, 's-active', 'Active Session', '/work/repo/project-a', 'm1')
    await createCliSession(accessToken, 's-inactive', 'Inactive Session', '/work/repo/project-a', 'm1')

    await login(page, accessToken)

    await page.getByRole('button', {
        name: /work\/repo/i
    }).first().click()

    const activeRow = page.locator('.session-list-item', { hasText: 'Active Session' }).first()
    await expect(activeRow).toContainText('codex')
    await expect(activeRow).toContainText('gpt-5.4')
    await expect(activeRow).toContainText('feature/chips')

    await page.goto(`${BASE_URL}/sessions/${activeSessionId}`, { waitUntil: 'domcontentloaded' })

    const headerTitle = page.locator('div.truncate.font-semibold').first()
    await expect(headerTitle).toHaveText('Active Session')

    const headerMeta = headerTitle.locator('xpath=following-sibling::div[1]')
    await expect(headerMeta).toContainText('codex')
    await expect(headerMeta).toContainText('gpt-5.4')
    await expect(headerMeta).toContainText('Very High')
    await expect(headerMeta).toContainText('feature/chips')
})
