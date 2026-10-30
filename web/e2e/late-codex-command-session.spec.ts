import { expect, test } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installHapiAuth, getHapiBaseUrl } from './helpers/hapi-live'

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1'))
})

test('stored shutdown result remains identifiable in the archived session UI', async ({ page, request }) => {
    const sessionId = process.env.HAPI_LATE_COMMAND_EXISTING_SESSION
    test.skip(process.env.HAPI_LIVE !== '1' || !sessionId, 'Requires the session created by this task native test')
    test.setTimeout(120_000)
    const directory = process.env.HAPI_LATE_COMMAND_TEST_DIR!
    const base = process.env.HAPI_LATE_COMMAND_LOCAL_URL ?? getHapiBaseUrl()
    const accessToken = process.env.HAPI_ACCESS_TOKEN!
    const auth = await request.post(`${base}/api/auth`, { data: { accessToken } })
    expect(auth.ok()).toBe(true)
    const headers = { Authorization: `Bearer ${(await auth.json()).token}` }
    const session = await request.get(`${base}/api/sessions/${sessionId}`, { headers })
    expect((await session.json()).session.active).toBe(false)
    const response = await request.get(`${base}/api/sessions/${sessionId}/messages?limit=200`, { headers })
    const rows = (await response.json()).messages
    const end = rows.find((row: { content: { content?: { data?: { output?: { type?: string } } } } }) =>
        row.content?.content?.data?.output?.type === 'exec_command_end')
    expect(end.content.content.data).toMatchObject({ is_error: true, output: { status: 'failed', exit_code: -1 } })
    expect(end.content.content.data.output.duration_ms).toBeGreaterThan(0)
    await installHapiAuth(page, base, accessToken)
    for (const mobile of [true, false]) {
        await page.setViewportSize(mobile ? { width: 412, height: 915 } : { width: 1440, height: 1000 })
        await page.goto(`${base}/sessions/${sessionId}`, { timeout: 90_000, waitUntil: 'domcontentloaded' })
        await expect(page.getByText('This session is inactive.', { exact: false })).toBeVisible()
        const card = page.getByRole('button').filter({ hasText: 'LATE_COMMAND_' }).first()
        await card.scrollIntoViewIfNeeded()
        await expect(card).toBeVisible()
        await expect(card.locator('.text-red-600').first()).toBeVisible()
        await expect(card.getByText('0.0s', { exact: true })).toHaveCount(0)
        await page.screenshot({ path: join(directory, 'screenshots', `native-stored-command-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true })
        await card.click()
        const dialog = page.getByRole('dialog')
        await expect(dialog).toBeVisible()
        await expect(dialog.getByText('Duration', { exact: true })).toBeVisible()
        await page.screenshot({ path: join(directory, 'screenshots', `native-stored-command-detail-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true })
        await page.keyboard.press('Escape')
    }
    await writeFile(join(directory, 'native-stored-evidence.json'), JSON.stringify({ sessionId, result: end }, null, 2))
})

test('archiving a real Codex session preserves a late background command result', async ({ page, request }, testInfo) => {
    const directory = process.env.HAPI_LATE_COMMAND_TEST_DIR
    test.skip(process.env.HAPI_LIVE !== '1' || !directory, 'Requires an isolated Full task environment and CODEX_HOME')
    test.setTimeout(360_000)
    const base = process.env.HAPI_LATE_COMMAND_LOCAL_URL ?? getHapiBaseUrl()
    const accessToken = process.env.HAPI_ACCESS_TOKEN!
    const auth = await request.post(`${base}/api/auth`, { data: { accessToken } })
    expect(auth.ok()).toBe(true)
    const headers = { Authorization: `Bearer ${(await auth.json()).token}` }
    const api = async (path: string, data?: unknown) => {
        const response = data === undefined ? await request.get(`${base}/api${path}`, { headers })
            : await request.post(`${base}/api${path}`, { headers, data, timeout: 90_000 })
        expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
        return response.json()
    }
    const marker = `LATE_COMMAND_${randomUUID()}`
    let requestedCommand = false
    const modelRequests: unknown[] = []
    const event = (response: ServerResponse, body: { type: string; [key: string]: unknown }) =>
        response.write(`event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`)
    const provider = createServer((incoming, response) => {
        const chunks: Buffer[] = []
        incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
        incoming.on('end', () => {
            if (!incoming.url?.endsWith('/responses')) { response.writeHead(404).end(); return }
            const input = JSON.parse(Buffer.concat(chunks).toString())
            modelRequests.push(input)
            const id = `resp_${randomUUID()}`
            response.writeHead(200, { 'Content-Type': 'text/event-stream' })
            event(response, { type: 'response.created', response: { id } })
            if (!requestedCommand) {
                requestedCommand = true
                const tool = input.tools?.find((tool: { name?: string }) => tool.name === 'exec_command')
                const name = tool?.name ?? 'exec_command'
                const item = { type: 'function_call', id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`,
                    name, arguments: JSON.stringify({ cmd: `node -e "console.log('${marker}');setInterval(()=>{},1000)"`, yield_time_ms: 1000, max_output_tokens: 100 }) }
                event(response, { type: 'response.output_item.done', item })
            } else {
                event(response, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant',
                    id: `msg_${id}`, content: [{ type: 'output_text', text: 'BACKGROUND_SERVER_READY' }] } })
            }
            event(response, { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } })
            response.end()
        })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    const port = (provider.address() as { port: number }).port
    let sessionId: string | undefined
    try {
        const home = join(directory!, 'codex-home')
        const cwd = join(directory!, `native-command-work-${randomUUID()}`)
        await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true })
        await writeFile(join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock_provider"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\ncheck_for_update_on_startup = false\n[model_providers.mock_provider]\nname = "Isolated late command test"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`)
        const { machines } = await api('/machines')
        expect(machines).toHaveLength(1)
        expect(machines[0].active).toBe(true)
        const spawn = await api(`/machines/${machines[0].id}/spawn`, { directory: cwd, agent: 'codex', model: 'mock-model', permissionMode: 'yolo' })
        if (spawn.type === 'success') sessionId = spawn.sessionId
        else {
            expect(spawn.message, JSON.stringify(spawn)).toContain('startup is still unconfirmed')
            // The Runner deliberately keeps a slow-starting process tracked.
            // Wait for that same session rather than starting a duplicate.
            await expect.poll(async () => {
                const { sessions } = await api('/sessions')
                sessionId = sessions.find((session: { id: string; active: boolean; metadata?: { path?: string } }) =>
                    session.active && session.metadata?.path === cwd)?.id
                return Boolean(sessionId)
            }, { timeout: 90_000 }).toBe(true)
        }
        const detail = async () => (await api(`/sessions/${sessionId}`)).session
        const messages = async () => (await api(`/sessions/${sessionId}/messages?limit=200`)).messages
        await expect.poll(async () => (await detail()).active, { timeout: 40_000 }).toBe(true)
        await api(`/sessions/${sessionId}/messages`, { text: 'Start the background server.', localId: randomUUID() })
        await expect.poll(async () => JSON.stringify(await messages()), { timeout: 60_000 }).toContain('BACKGROUND_SERVER_READY')
        const original = (await messages()).find((row: { content: { content?: { data?: { type?: string; input?: { command?: string } } } } }) =>
            row.content?.content?.data?.type === 'tool-call' && row.content.content.data.input?.command?.includes(marker))
        expect(original, 'native command started').toBeTruthy()
        for (let i = 0; i < 5; i++) {
            await api(`/sessions/${sessionId}/messages`, { text: `Follow-up ${i}`, localId: randomUUID() })
            await expect.poll(async () => (await detail()).thinking, { timeout: 30_000 }).toBe(false)
        }
        const archived = await request.post(`${base}/api/sessions/${sessionId}/archive`, { headers, data: {}, timeout: 90_000 })
        // Windows cleanup can exceed the existing Hub RPC budget (#2055/#2126).
        // Verify the actual lifecycle and persisted result independently of that response.
        await testInfo.attach('archive-response', { body: JSON.stringify({ status: archived.status(), body: await archived.text() }), contentType: 'application/json' })
        await expect.poll(async () => (await detail()).active, { timeout: 60_000 }).toBe(false)
        const rows = await messages()
        const callId = original.content.content.data.callId
        const end = rows.find((row: { content: { content?: { data?: { type?: string; callId?: string } } } }) =>
            row.content?.content?.data?.type === 'tool-call-result' && row.content.content.data.callId === callId)
        expect(end, 'shutdown persisted the original command result').toBeTruthy()
        expect(end.content.content.data.is_error).toBe(true)
        expect(end.content.content.data.output.duration_ms).toBeGreaterThan(0)
        await installHapiAuth(page, base, accessToken)
        await page.setViewportSize({ width: 412, height: 915 })
        await page.goto(`${base}/sessions/${sessionId}`, { timeout: 90_000, waitUntil: 'domcontentloaded' })
        await expect(page.getByText('This session is inactive.', { exact: false })).toBeVisible()
        const card = page.getByRole('button').filter({ hasText: marker }).first()
        await expect(card).toBeVisible()
        await expect(card.locator('.text-red-600').first()).toBeVisible()
        await expect(card.getByText('0.0s', { exact: true })).toHaveCount(0)
        await page.screenshot({ path: join(directory!, 'screenshots', 'native-archived-command-mobile.png'), fullPage: true })
        await page.setViewportSize({ width: 1440, height: 1000 })
        await expect(card).toBeVisible()
        await page.screenshot({ path: join(directory!, 'screenshots', 'native-archived-command-desktop.png'), fullPage: true })
        await testInfo.attach('native-command-evidence', { body: JSON.stringify({ sessionId, callId, startSeq: original.seq, endSeq: end.seq,
            result: end.content.content.data, modelRequests: modelRequests.length }), contentType: 'application/json' })
        await writeFile(join(directory!, 'native-command-evidence.json'), JSON.stringify({ sessionId, callId, startSeq: original.seq,
            endSeq: end.seq, archiveStatus: archived.status(), result: end.content.content.data }, null, 2))
        // Keep a cleanup/API failure visible even if the result and UI checks pass.
        expect(archived.status()).toBe(200)
    } finally {
        if (sessionId) await api(`/sessions/${sessionId}/archive`, {}).catch(() => {})
        await writeFile(join(directory!, 'native-model-requests.json'), JSON.stringify(modelRequests, null, 2))
        provider.closeAllConnections()
        await new Promise<void>(resolve => provider.close(() => resolve()))
    }
})
