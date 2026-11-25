import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getHapiBaseUrl, installHapiAuth } from './helpers/hapi-live'

// Uses a real isolated Hub/Runner/machine and official Codex binary. The model
// provider is a deterministic local Responses server, so no paid calls occur.
const enabled = process.env.HAPI_LIVE === '1' && process.env.HAPI_LIST_FORK_LIVE === '1'
    && Boolean(process.env.HAPI_FORK_TEST_DIR) && Boolean(process.env.HAPI_ACCESS_TOKEN)

async function dismissOverlays(page: Page) {
    for (const locator of [page.getByRole('button', { name: 'Got it' }), page.getByRole('button', { name: 'Dismiss' })]) {
        for (const button of await locator.all()) {
            if (await button.isVisible()) await button.click()
        }
    }
}

test('forks an active Codex session from the session-list menu', async ({ page, request }, testInfo) => {
    test.skip(!enabled, 'Requires an isolated Full environment and HAPI_LIST_FORK_LIVE opt-in')
    test.setTimeout(420_000)
    const base = process.env.HAPI_FORK_LOCAL_URL ?? getHapiBaseUrl()
    const runtime = process.env.HAPI_FORK_TEST_DIR!
    const accessToken = process.env.HAPI_ACCESS_TOKEN!
    const auth = await request.post(`${base}/api/auth`, { data: { accessToken } })
    expect(auth.ok()).toBe(true)
    const headers = { Authorization: `Bearer ${(await auth.json()).token}` }
    const api = async (path: string, data?: unknown) => {
        const response = data === undefined
            ? await request.get(`${base}/api${path}`, { headers })
            : await request.post(`${base}/api${path}`, { headers, data, timeout: 240_000 })
        expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
        return response.json()
    }
    const run = randomUUID()
    const title = `List fork ${run}`
    const sourcePrompt = `SOURCE_CONTEXT_${run}`
    const childPrompt = `CHILD_PROBE_${run}`
    const modelInputs: string[] = []
    const provider = createServer((incoming, response) => {
        const chunks: Buffer[] = []
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
        incoming.on('end', () => {
            if (!incoming.url?.endsWith('/responses')) { response.writeHead(404).end(); return }
            const input = Buffer.concat(chunks).toString()
            modelInputs.push(input)
            const id = randomUUID()
            const text = input.includes(childPrompt) ? 'CHILD_READY' : 'SOURCE_READY'
            const events = [
                { type: 'response.created', response: { id } },
                { type: 'response.output_item.done', item: { id: `m_${id}`, type: 'message', role: 'assistant',
                    content: [{ type: 'output_text', text }] } },
                { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } }
            ]
            response.writeHead(200, { 'Content-Type': 'text/event-stream' })
            response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
        })
    })
    const sessions: string[] = []
    try {
        await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
        const providerPort = (provider.address() as { port: number }).port
        const home = join(runtime, 'codex-home')
        const cwd = join(runtime, `work-${run}`)
        await mkdir(home, { recursive: true })
        await mkdir(cwd, { recursive: true })
        await writeFile(join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "list_fork_test"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.list_fork_test]\nname = "List fork acceptance"\nbase_url = "http://127.0.0.1:${providerPort}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`)
        await expect.poll(async () => (await api('/machines')).machines.length, { timeout: 90_000 }).toBe(1)
        const { machines } = await api('/machines')
        const spawn = await api(`/machines/${machines[0].id}/spawn`, {
            directory: cwd, agent: 'codex', model: 'mock-model', permissionMode: 'read-only'
        })
        let source = spawn.type === 'success' ? spawn.sessionId as string : undefined
        if (!source) {
            await expect.poll(async () => {
                const list = await api('/sessions')
                source = list.sessions.find((session: { active: boolean; metadata?: { path?: string } }) =>
                    session.active && session.metadata?.path === cwd)?.id
                return Boolean(source)
            }, { timeout: 90_000 }).toBe(true)
        }
        if (!source) throw new Error('Source fixture did not become ready')
        sessions.push(source)
        const rename = await request.patch(`${base}/api/sessions/${source}`, { headers, data: { name: title } })
        expect(rename.ok(), await rename.text()).toBe(true)
        const detail = async (id: string) => (await api(`/sessions/${id}`)).session
        const messages = async (id: string) => JSON.stringify(await api(`/sessions/${id}/messages?limit=200`))
        await expect.poll(async () => (await detail(source!)).metadata?.name, { timeout: 20_000 }).toBe(title)
        await expect.poll(async () => (await detail(source!)).metadata?.capabilities?.conversationHistory?.forkCurrent,
            { timeout: 90_000 }).toBe(true)
        await api(`/sessions/${source}/messages`, { text: sourcePrompt, localId: sourcePrompt })
        await expect.poll(() => messages(source!), { timeout: 40_000 }).toContain('SOURCE_READY')
        await expect.poll(async () => (await detail(source!)).thinking).toBe(false)

        await installHapiAuth(page, base, accessToken)
        await page.setViewportSize({ width: 1440, height: 1000 })
        await page.goto(`${base}/sessions/${source}`)
        await dismissOverlays(page)
        const sourceRow = page.locator('button[data-session-scroll-anchor]')
            .filter({ hasText: title }).filter({ hasNotText: 'Fork:' }).first()
        await expect(sourceRow).toBeVisible()
        await sourceRow.click({ button: 'right' })
        const menu = page.getByRole('menu')
        await expect(menu.getByRole('menuitem', { name: 'Fork session' })).toBeVisible()
        const callsBeforeFork = modelInputs.length
        await menu.getByRole('menuitem', { name: 'Fork session' }).click()
        await expect(page.getByRole('dialog').getByRole('heading', { name: 'Fork session' })).toBeVisible()
        const forkResponse = page.waitForResponse(response =>
            response.url().endsWith(`/sessions/${source}/fork`) && response.request().method() === 'POST')
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
        const response = await forkResponse
        expect(response.ok(), await response.text()).toBe(true)
        const child = (await response.json()).sessionId as string
        sessions.push(child)
        await expect(page).toHaveURL(new RegExp(`/sessions/${child}$`))
        expect((await detail(child)).metadata?.summary?.text).toBe(`Fork: ${title}`)
        await expect(page.getByText(sourcePrompt, { exact: true })).toBeVisible()
        await dismissOverlays(page)
        const screenshotDirectory = join(runtime, 'screenshots')
        await mkdir(screenshotDirectory, { recursive: true })
        await page.screenshot({ path: join(screenshotDirectory, 'live-fork-child-inherited.png') })
        expect(modelInputs).toHaveLength(callsBeforeFork)
        expect(await messages(source)).toContain(sourcePrompt)
        expect(await messages(child)).toContain(sourcePrompt)
        expect((await detail(source)).active).toBe(true)
        expect((await detail(child)).active).toBe(true)

        await api(`/sessions/${child}/messages`, { text: childPrompt, localId: childPrompt })
        await expect.poll(() => messages(child), { timeout: 40_000 }).toContain('CHILD_READY')
        await expect(page.getByText('CHILD_READY', { exact: true })).toBeVisible()
        await dismissOverlays(page)
        await page.screenshot({ path: join(screenshotDirectory, 'live-fork-child-continued.png') })
        const childInput = modelInputs.find(input => input.includes(childPrompt))
        expect(childInput).toContain(sourcePrompt)

        // Archive the source, then fork it from the same list menu. The source
        // must remain archived and must not be resumed by the UI or Runner.
        const callsBeforeArchivedFork = modelInputs.length
        const sourceBeforeArchive = await messages(source)
        const archive = await request.post(`${base}/api/sessions/${source}/archive`, {
            headers, data: {}, timeout: 120_000
        })
        expect([200, 500]).toContain(archive.status())
        await expect.poll(async () => (await detail(source)).active, { timeout: 30_000 }).toBe(false)
        await expect.poll(async () => (await detail(source)).metadata?.lifecycleState,
            { timeout: 30_000 }).toBe('archived')
        await expect(sourceRow).toBeVisible()
        await sourceRow.click({ button: 'right' })
        await expect(menu.getByRole('menuitem', { name: 'Fork session' })).toBeVisible()
        await page.waitForTimeout(250)
        await page.screenshot({ path: join(screenshotDirectory, 'live-fork-archived-menu.png') })
        await menu.getByRole('menuitem', { name: 'Fork session' }).click()
        await expect(page.getByRole('dialog').getByRole('heading', { name: 'Fork session' })).toBeVisible()
        await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click()
        let archivedChild: string | undefined
        await expect.poll(async () => {
            const candidate = new URL(page.url()).pathname.match(/\/sessions\/([^/]+)$/)?.[1]
            if (candidate && candidate !== source && candidate !== child) archivedChild = candidate
            return archivedChild
        }, { timeout: 300_000 }).toBeTruthy()
        if (!archivedChild) throw new Error('Archived fork child did not appear')
        sessions.push(archivedChild)
        await expect(page).toHaveURL(new RegExp(`/sessions/${archivedChild}$`))
        expect((await detail(archivedChild)).metadata?.forkedFrom).toBe(source)
        expect(modelInputs).toHaveLength(callsBeforeArchivedFork)
        expect((await detail(source)).active).toBe(false)
        expect((await detail(source)).metadata?.lifecycleState).toBe('archived')
        expect(await messages(source)).toBe(sourceBeforeArchive)
        expect((await detail(archivedChild)).active).toBe(true)
        expect((await detail(archivedChild)).metadata?.summary?.text).toBe(`Fork: ${title}`)
        expect(await messages(archivedChild)).toContain(sourcePrompt)
        await expect(page.getByText(sourcePrompt, { exact: true })).toBeVisible()
        await dismissOverlays(page)
        await page.screenshot({ path: join(screenshotDirectory, 'live-fork-archived-child.png') })

        await testInfo.attach('session-list-fork-evidence', {
            body: JSON.stringify({ source, child, archivedChild, modelCallsDuringFork: 0,
                sourcePromptInherited: Boolean(childInput?.includes(sourcePrompt)),
                archivedSourcePreserved: (await detail(source)).active === false,
                archivedSourceHistoryPreserved: (await messages(source)) === sourceBeforeArchive }),
            contentType: 'application/json'
        })
    } finally {
        for (const id of sessions.reverse()) await api(`/sessions/${id}/archive`, {}).catch(() => {})
        provider.closeAllConnections()
        await new Promise<void>(resolve => provider.close(() => resolve()))
    }
})
