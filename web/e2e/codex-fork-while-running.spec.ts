import { expect, test } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getHapiBaseUrl, installHapiAuth } from './helpers/hapi-live'

// The task Runner must inherit CODEX_HOME=<HAPI_FORK_TEST_DIR>/codex-home.
// Uses the installed Codex binary and a deterministic local Responses server,
// with a real isolated Hub, Runner, machine and browser. Never use production.
const enabled = process.env.HAPI_LIVE === '1' && process.env.HAPI_FORK_LIVE === '1'
    && Boolean(process.env.HAPI_FORK_TEST_DIR) && Boolean(process.env.HAPI_ACCESS_TOKEN)

for (const mobile of [false, true]) {
    test(`historical Codex fork preserves a running source (${mobile ? 'mobile' : 'desktop'})`, async ({ page, request }, testInfo) => {
        test.skip(!enabled, 'Requires an isolated Full environment and explicit HAPI_FORK_LIVE opt-in')
        test.setTimeout(180_000)
        const base = process.env.HAPI_FORK_LOCAL_URL ?? getHapiBaseUrl()
        const directory = process.env.HAPI_FORK_TEST_DIR!
        const accessToken = process.env.HAPI_ACCESS_TOKEN!
        const auth = await request.post(`${base}/api/auth`, { data: { accessToken } })
        expect(auth.ok()).toBe(true)
        const headers = { Authorization: `Bearer ${(await auth.json()).token}` }
        const api = async (path: string, data?: unknown) => {
            const response = data === undefined
                ? await request.get(`${base}/api${path}`, { headers })
                : await request.post(`${base}/api${path}`, { headers, data, timeout: 60_000 })
            expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
            return response.json()
        }
        const run = randomUUID()
        const retained = `RETAINED_${run}`
        const excluded = `EXCLUDED_${run}`
        const running = `RUNNING_${run}`
        const childProbe = `CHILD_PROBE_${run}`
        let held: { response: ServerResponse; id: string } | undefined
        const modelInputs: string[] = []
        const event = (response: ServerResponse, body: { type: string; [key: string]: unknown }) =>
            response.write(`event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`)
        const finish = (response: ServerResponse, id: string, text: string) => {
            event(response, { type: 'response.output_item.done', item: { type: 'message', role: 'assistant',
                id: `msg_${id}`, content: [{ type: 'output_text', text }] } })
            event(response, { type: 'response.completed', response: { id,
                usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } })
            response.end()
        }
        const provider = createServer((incoming, response) => {
            const chunks: Buffer[] = []
            incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
            incoming.on('end', () => {
                if (!incoming.url?.endsWith('/responses')) { response.writeHead(404).end(); return }
                const input = Buffer.concat(chunks).toString()
                modelInputs.push(input)
                const id = randomUUID()
                response.writeHead(200, { 'Content-Type': 'text/event-stream' })
                event(response, { type: 'response.created', response: { id } })
                if (input.includes(childProbe)) finish(response, id, 'CHILD_CONTEXT_OK')
                else if (input.includes(running)) held = { response, id }
                else finish(response, id, input.includes(excluded) ? 'SECOND_DONE' : 'FIRST_DONE')
            })
        })
        const sessions: string[] = []
        try {
            await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
            const port = (provider.address() as { port: number }).port
            const home = join(directory, 'codex-home')
            await mkdir(home, { recursive: true })
            const cwd = join(directory, `work-${run}`)
            await mkdir(cwd, { recursive: true })
            await writeFile(join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock_provider"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.mock_provider]\nname = "Isolated fork test"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`)
            const { machines } = await api('/machines')
            expect(machines).toHaveLength(1)
            const spawn = await api(`/machines/${machines[0].id}/spawn`, {
                directory: cwd, agent: 'codex', model: 'mock-model', permissionMode: 'read-only'
            })
            expect(spawn.type, JSON.stringify(spawn)).toBe('success')
            const source = spawn.sessionId as string
            sessions.push(source)
            const detail = async (id: string) => (await api(`/sessions/${id}`)).session
            const messages = async (id: string) => JSON.stringify(await api(`/sessions/${id}/messages?limit=200`))
            await expect.poll(async () => (await detail(source)).metadata?.capabilities?.conversationHistory?.forkAtMessage,
                { timeout: 30_000 }).toBe(true)
            for (const [text, result] of [[retained, 'FIRST_DONE'], [excluded, 'SECOND_DONE']]) {
                await api(`/sessions/${source}/messages`, { text, localId: text })
                await expect.poll(() => messages(source), { timeout: 30_000 }).toContain(result)
                await expect.poll(async () => (await detail(source)).thinking).toBe(false)
            }
            await api(`/sessions/${source}/messages`, { text: running, localId: running })
            await expect.poll(() => Boolean(held), { timeout: 30_000 }).toBe(true)
            await expect.poll(async () => (await detail(source)).thinking).toBe(true)
            // Both API and UI must retain the busy guard for current forks.
            const current = await request.post(`${base}/api/sessions/${source}/fork`, { headers, data: {} })
            expect(current.status()).toBe(409)
            expect(await current.json()).toMatchObject({ error: 'Session is busy' })
            const activeBoundary = await request.post(`${base}/api/sessions/${source}/fork`, {
                headers, data: { messageLocalId: running }
            })
            expect(activeBoundary.status()).toBe(409)
            await installHapiAuth(page, base, accessToken)
            await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
            await page.goto(`${base}/sessions/${source}`)
            const boundary = page.locator('[data-hapi-message-role="user"]').filter({ hasText: excluded })
            await expect(boundary).toBeVisible()
            await boundary.hover()
            await expect(boundary.getByRole('button', { name: 'Rewind', exact: true })).toHaveCount(0)
            await expect(boundary.getByRole('button', { name: 'Fork', exact: true })).toBeVisible()
            await boundary.getByRole('button', { name: 'Fork', exact: true }).click()
            const forkResponse = page.waitForResponse(response => response.url().endsWith(`/sessions/${source}/fork`) && response.request().method() === 'POST')
            await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
            const response = await forkResponse
            expect(response.ok(), await response.text()).toBe(true)
            const child = (await response.json()).sessionId as string
            sessions.push(child)
            await expect(page).toHaveURL(new RegExp(`/sessions/${child}$`))
            expect((await detail(source)).thinking).toBe(true)
            expect(held?.response.writableEnded).toBe(false)
            const childHistory = await messages(child)
            expect(childHistory).toContain(retained)
            expect(childHistory).not.toContain(excluded)
            expect(childHistory).not.toContain(running)
            await expect(page.getByText(retained, { exact: true })).toBeVisible()
            await expect(page.getByText(excluded, { exact: true })).toHaveCount(0)
            await api(`/sessions/${child}/messages`, { text: childProbe, localId: childProbe })
            await expect.poll(() => messages(child), { timeout: 30_000 }).toContain('CHILD_CONTEXT_OK')
            const childInput = modelInputs.find(input => input.includes(childProbe))!
            expect(childInput).toContain(retained)
            expect(childInput).not.toContain(excluded)
            expect(childInput).not.toContain(running)
            // The first historical boundary produces an empty native prefix.
            const emptyFork = await api(`/sessions/${source}/fork`, { messageLocalId: retained })
            sessions.push(emptyFork.sessionId)
            const emptyHistory = await messages(emptyFork.sessionId)
            expect(emptyHistory).not.toContain(retained)
            expect(emptyHistory).not.toContain(excluded)
            expect((await detail(source)).thinking).toBe(true)
            finish(held!.response, held!.id, 'SOURCE_COMPLETED_AFTER_FORK')
            await expect.poll(() => messages(source), { timeout: 30_000 }).toContain('SOURCE_COMPLETED_AFTER_FORK')
            await expect.poll(async () => (await detail(source)).thinking).toBe(false)
            expect(await messages(child)).not.toContain('SOURCE_COMPLETED_AFTER_FORK')
            await testInfo.attach('native-fork-context', { body: JSON.stringify({ source, child, modelRequests: modelInputs.length,
                inheritedRetained: childInput.includes(retained), inheritedExcluded: childInput.includes(excluded), inheritedRunning: childInput.includes(running) }), contentType: 'application/json' })
        } finally {
            if (held && !held.response.writableEnded) held.response.end()
            for (const id of sessions.reverse()) await api(`/sessions/${id}/archive`, {}).catch(() => {})
            provider.closeAllConnections()
            await new Promise<void>(resolve => provider.close(() => resolve()))
        }
    })
}
