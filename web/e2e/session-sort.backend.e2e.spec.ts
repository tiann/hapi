import { expect, test, type Page } from '@playwright/test'

const BASE_URL = process.env.HAPI_E2E_BASE_URL ?? 'http://127.0.0.1:3906'
const BASE_TOKEN = process.env.HAPI_E2E_CLI_TOKEN ?? 'pw-test-token'
const RUN_ID = process.env.HAPI_E2E_RUN_ID ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function token(namespaceSuffix: string): string {
    return `${BASE_TOKEN}:session-sort-${RUN_ID}-${namespaceSuffix}`
}

async function login(page: Page, accessToken: string): Promise<void> {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })
    await page.getByPlaceholder('Access token').fill(accessToken)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await expect(page.getByText(/sessions in .* projects/i)).toBeVisible({ timeout: 15_000 })
}

async function expandAllGroups(page: Page): Promise<void> {
    const headers = page.locator('button').filter({ has: page.locator('span.font-semibold') })
    const count = await headers.count()
    for (let i = 0; i < count; i += 1) {
        await headers.nth(i).click()
    }
    await expect(page.locator('.session-list-item').first()).toBeVisible({ timeout: 10_000 })
}

async function sessionRowTexts(page: Page): Promise<string[]> {
    return page.locator('.session-list-item').allTextContents()
}

function findIndex(rows: string[], text: string): number {
    return rows.findIndex((row) => row.includes(text))
}

async function authJwt(accessToken: string): Promise<string> {
    const response = await fetch(`${BASE_URL}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken })
    })
    expect(response.status).toBe(200)
    const json = await response.json() as { token: string }
    return json.token
}

type SessionSortPreference = {
    sortMode: 'auto' | 'manual'
    manualOrder: {
        groupOrder: string[]
        sessionOrder: Record<string, string[]>
    }
    version: number
}

async function getPreference(jwt: string): Promise<SessionSortPreference> {
    const response = await fetch(`${BASE_URL}/api/preferences/session-sort`, {
        headers: { authorization: `Bearer ${jwt}` }
    })
    expect(response.status).toBe(200)
    const json = await response.json() as { preference: SessionSortPreference }
    return json.preference
}

async function putPreference(
    jwt: string,
    payload: {
        sortMode: 'auto' | 'manual'
        manualOrder: {
            groupOrder: string[]
            sessionOrder: Record<string, string[]>
        }
        expectedVersion?: number
    }
): Promise<{ status: number; json: unknown }> {
    const response = await fetch(`${BASE_URL}/api/preferences/session-sort`, {
        method: 'PUT',
        headers: {
            authorization: `Bearer ${jwt}`,
            'content-type': 'application/json'
        },
        body: JSON.stringify(payload)
    })
    const json = await response.json().catch(() => ({}))
    return { status: response.status, json }
}

async function createCliSession(
    accessToken: string,
    tag: string,
    name: string,
    path: string,
    machineId: string
): Promise<void> {
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
                flavor: 'claude'
            },
            agentState: null
        })
    })
    expect(response.status).toBe(200)
}

async function seedBaseSessions(accessToken: string): Promise<void> {
    await createCliSession(accessToken, 's-alpha', 'Alpha', '/work/repo/a', 'm1')
    await createCliSession(accessToken, 's-beta', 'Beta', '/work/repo/a', 'm1')
    await createCliSession(accessToken, 's-gamma', 'Gamma', '/work/repo/b', 'm1')
    await createCliSession(accessToken, 's-delta', 'Delta', '/work/repo/b', 'm1')
}

async function resetPreferenceToAuto(accessToken: string): Promise<void> {
    const jwt = await authJwt(accessToken)
    const preference = await getPreference(jwt)
    const result = await putPreference(jwt, {
        sortMode: 'auto',
        manualOrder: {
            groupOrder: [],
            sessionOrder: {}
        },
        expectedVersion: preference.version
    })
    expect(result.status).toBe(200)
}

async function bootstrapNamespace(accessToken: string): Promise<void> {
    await seedBaseSessions(accessToken)
    await resetPreferenceToAuto(accessToken)
}

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

test('session sort: manual mode UI flow + persistence + stale IDs + new session append', async ({ page }) => {
    const accessToken = token('manual')
    await bootstrapNamespace(accessToken)

    await login(page, accessToken)
    await expandAllGroups(page)

    await expect(page.locator('button[title="Sort: automatic"]')).toBeVisible()
    await page.locator('button[title="Sort: automatic"]').click()
    await expect(page.locator('button[title="Sort: manual"]')).toBeVisible()

    const alphaRow = page.locator('.session-list-item', { hasText: 'Alpha' }).first()
    await alphaRow.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move Up' }).click()

    const afterMoveRows = await sessionRowTexts(page)
    expect(findIndex(afterMoveRows, 'Alpha')).toBeLessThan(findIndex(afterMoveRows, 'Beta'))

    await page.locator('.session-list-item', { hasText: 'Alpha' }).first().click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Move Up' })).toBeDisabled()
    await page.keyboard.press('Escape')

    const initialHeaders = await page.locator('span.font-semibold').allTextContents()
    const initialGroups = initialHeaders.filter((text) => text.includes('repo/'))
    expect(initialGroups.length).toBeGreaterThan(1)
    const movedGroup = initialGroups[1]

    const movedGroupHeader = page.locator('button', {
        has: page.locator('span.font-semibold', { hasText: movedGroup })
    }).first()
    await movedGroupHeader.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move Up' }).click()

    await expect.poll(async () => {
        const headers = await page.locator('span.font-semibold').allTextContents()
        const groupNames = headers.filter((text) => text.includes('repo/'))
        return groupNames[0] ?? ''
    }).toBe(movedGroup)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('button[title="Sort: manual"]')).toBeVisible({ timeout: 15_000 })
    await expandAllGroups(page)

    const afterReloadRows = await sessionRowTexts(page)
    expect(findIndex(afterReloadRows, 'Alpha')).toBeLessThan(findIndex(afterReloadRows, 'Beta'))

    const jwt = await authJwt(accessToken)
    const preference = await getPreference(jwt)
    const stalePut = await putPreference(jwt, {
        sortMode: 'manual',
        expectedVersion: preference.version,
        manualOrder: {
            groupOrder: ['fake-group', ...preference.manualOrder.groupOrder],
            sessionOrder: {
                ...preference.manualOrder.sessionOrder,
                'fake-group': ['fake-session']
            }
        }
    })
    expect(stalePut.status).toBe(200)

    await expect(page.locator('.session-list-item', { hasText: 'Alpha' }).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.session-list-item', { hasText: 'Beta' }).first()).toBeVisible()

    await createCliSession(accessToken, 's-epsilon', 'Epsilon', '/work/repo/a', 'm1')

    await expect(page.locator('.session-list-item', { hasText: 'Epsilon' }).first()).toBeVisible({ timeout: 15_000 })
    const withNewRows = await sessionRowTexts(page)
    const alphaIndex = findIndex(withNewRows, 'Alpha')
    const betaIndex = findIndex(withNewRows, 'Beta')
    const epsilonIndex = findIndex(withNewRows, 'Epsilon')
    expect(epsilonIndex).toBeGreaterThan(alphaIndex)
    expect(epsilonIndex).toBeGreaterThan(betaIndex)
})

test('session sort: SSE sync across two clients', async ({ browser }) => {
    const accessToken = token('sse')
    await bootstrapNamespace(accessToken)
    await createCliSession(accessToken, 's-epsilon', 'Epsilon', '/work/repo/a', 'm1')

    const contextA = await browser.newContext()
    const contextB = await browser.newContext()
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()

    await login(pageA, accessToken)
    await login(pageB, accessToken)
    await expandAllGroups(pageA)
    await expandAllGroups(pageB)

    await pageA.locator('button[title="Sort: automatic"]').click()
    await expect(pageA.locator('button[title="Sort: manual"]')).toBeVisible()
    await expect(pageB.locator('button[title="Sort: manual"]')).toBeVisible({ timeout: 15_000 })

    const beforeRows = await sessionRowTexts(pageA)
    const repoAOrder = ['Alpha', 'Beta', 'Epsilon']
        .map((name) => ({ name, index: findIndex(beforeRows, name) }))
        .filter((entry) => entry.index >= 0)
        .sort((a, b) => a.index - b.index)
    expect(repoAOrder.length).toBeGreaterThan(1)

    const moveTarget = repoAOrder[1]
    const expectedAbove = repoAOrder[0]

    await pageA.locator('.session-list-item', { hasText: moveTarget.name }).first().click({ button: 'right' })
    await pageA.getByRole('menuitem', { name: 'Move Up' }).click()

    await expect.poll(async () => {
        const rows = await sessionRowTexts(pageB)
        return {
            moved: findIndex(rows, moveTarget.name),
            above: findIndex(rows, expectedAbove.name)
        }
    }, { timeout: 20_000 }).toEqual(expect.objectContaining({
        moved: expect.any(Number),
        above: expect.any(Number)
    }))

    const rowsB = await sessionRowTexts(pageB)
    expect(findIndex(rowsB, moveTarget.name)).toBeLessThan(findIndex(rowsB, expectedAbove.name))

    await contextA.close()
    await contextB.close()
})

test('session sort: API conflict path returns 409 version_mismatch', async () => {
    const accessToken = token('conflict')
    await bootstrapNamespace(accessToken)

    const jwt = await authJwt(accessToken)
    const preference = await getPreference(jwt)

    const payload = {
        sortMode: preference.sortMode,
        manualOrder: preference.manualOrder,
        expectedVersion: preference.version
    }

    const first = await putPreference(jwt, payload)
    expect(first.status).toBe(200)

    const second = await putPreference(jwt, payload)
    expect(second.status).toBe(409)
    expect((second.json as { error?: string }).error).toBe('version_mismatch')
    expect(((second.json as { preference: SessionSortPreference }).preference.version)).toBeGreaterThan(preference.version)
})
