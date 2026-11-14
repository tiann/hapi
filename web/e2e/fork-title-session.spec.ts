import { expect, test, type APIRequestContext } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { installHapiAuth } from './helpers/hapi-live'

// Run against an isolated Full task environment whose Codex and title provider
// both target this mock endpoint. Never use a default home or production URL.
test.describe('fork title (real Hub, Runner and installed Codex)', () => {
    test.skip(process.env.HAPI_FORK_TITLE_LIVE !== '1', 'Requires isolated task configuration')
    test.describe.configure({ mode: 'serial' })
    const base = process.env.HAPI_URL?.replace(/\/$/, '') ?? ''
    const accessToken = process.env.HAPI_ACCESS_TOKEN ?? ''
    const directory = process.env.HAPI_FORK_TEST_DIRECTORY ?? ''
    const mockPort = Number(process.env.HAPI_FORK_TITLE_MOCK_PORT)
    let api: APIRequestContext
    let sourceId = ''
    const titleRequests: Array<{ prompt: string; response: ServerResponse }> = []
    const created: string[] = []
    let titleMode: 'hold' | 'fail' | 'success' = 'hold'
    const provider = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(Buffer.from(chunk)))
        request.on('end', () => {
            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
            if (request.url?.endsWith('/chat/completions')) {
                titleRequests.push({ prompt: JSON.stringify(body.messages), response })
                if (titleMode === 'fail') response.writeHead(503).end('Test provider failure')
                if (titleMode === 'success') response.writeHead(200, { 'Content-Type': 'application/json' })
                    .end(JSON.stringify({ choices: [{ message: { content: 'Generated payment title' } }] }))
                return
            }
            if (request.url?.endsWith('/responses')) {
                const id = randomUUID()
                const events = [
                    { type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`,
                        content: [{ type: 'output_text', text: 'Payment optimization test answer.' }] } },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }
                ]
                response.writeHead(200, { 'Content-Type': 'text/event-stream' })
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
                return
            }
            response.writeHead(404).end()
        })
    })
    const detail = async (id: string) => {
        const response = await api.get(`${base}/api/sessions/${id}`)
        expect(response.ok()).toBeTruthy()
        return (await response.json()).session
    }
    const fork = async (data: Record<string, unknown> = {}) => {
        const response = await api.post(`${base}/api/sessions/${sourceId}/fork`, { data, timeout: 90_000 })
        expect(response.ok(), await response.text()).toBeTruthy()
        const result = await response.json()
        expect(result.sessionId).toBeTruthy()
        created.push(result.sessionId)
        return result.sessionId as string
    }
    const finish = (index: number, title: string) => titleRequests[index]!.response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ choices: [{ message: { content: title } }] }))

    test.beforeAll(async ({ playwright }) => {
        expect(base).toMatch(/^https?:\/\/(?:127\.0\.0\.1:\d+|[^/]+\.hapi-test\.techotaku39\.top)$/)
        expect(base).not.toContain(':3006')
        expect(directory).toBeTruthy()
        expect(mockPort).toBeGreaterThan(1024)
        expect(accessToken).toBeTruthy()
        await new Promise<void>(resolve => provider.listen(mockPort, '127.0.0.1', resolve))
        const auth = await playwright.request.newContext()
        const response = await auth.post(`${base}/api/auth`, { data: { accessToken } })
        expect(response.ok()).toBeTruthy()
        const { token } = await response.json()
        await auth.dispose()
        api = await playwright.request.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` } })
        await expect.poll(async () => (await (await api.get(`${base}/api/machines`)).json()).machines.length,
            { timeout: 60_000 }).toBeGreaterThan(0)
        const machines = await (await api.get(`${base}/api/machines`)).json()
        expect(machines.machines.length).toBeGreaterThan(0)
        const spawn = await api.post(`${base}/api/machines/${machines.machines[0].id}/spawn`, { data: {
            directory, agent: 'codex', model: 'mock-model', permissionMode: 'read-only', sessionType: 'simple'
        }, timeout: 90_000 })
        const result = await spawn.json()
        expect(result.type, JSON.stringify(result)).toBe('success')
        sourceId = result.sessionId
        created.push(sourceId)
        await expect.poll(async () => (await detail(sourceId)).metadata?.capabilities?.conversationHistory?.forkCurrent,
            { timeout: 60_000 }).toBe(true)
        await api.patch(`${base}/api/sessions/${sourceId}`, { data: { name: 'Current payment discussion' } })
        const send = await api.post(`${base}/api/sessions/${sourceId}/messages`, {
            data: { text: 'Discuss payment optimization.', localId: randomUUID() }
        })
        expect(send.ok()).toBeTruthy()
        await expect.poll(async () => {
            const messages = await (await api.get(`${base}/api/sessions/${sourceId}/messages`)).json()
            return JSON.stringify(messages).includes('Payment optimization test answer.')
        }, { timeout: 60_000 }).toBe(true)
        await expect.poll(async () => (await detail(sourceId)).thinking, { timeout: 30_000 }).toBe(false)
    })

    test.afterAll(async () => {
        // Archive is best-effort here; the task stop script owns final detached
        // process cleanup, including a native archive that does not return.
        const archives = await Promise.allSettled(created.reverse().map(id =>
            api?.post(`${base}/api/sessions/${id}/archive`, { timeout: 10_000 })))
        const deferred = archives.filter(result => result.status === 'rejected').length
        if (deferred) console.info(`${deferred} archive request(s) deferred to task environment cleanup`)
        for (const request of titleRequests) if (!request.response.writableEnded) request.response.destroy()
        await api?.dispose()
        provider.closeAllConnections()
        await new Promise<void>(resolve => provider.close(() => resolve()))
    })

    test('shows the seed immediately, then saves provider output without another conversation turn', async ({ page }) => {
        titleMode = 'hold'
        const index = titleRequests.length
        const id = await fork()
        await expect.poll(() => titleRequests.length).toBe(index + 1)
        expect((await detail(id)).metadata.summary.text).toBe('Fork: Current payment discussion')
        expect(titleRequests[index]!.prompt).toContain('Discuss payment optimization.')
        await installHapiAuth(page, base, accessToken)
        await page.goto(`${base}/sessions/${id}`, { waitUntil: 'domcontentloaded' })
        await expect(page.getByText('Fork: Current payment discussion', { exact: true }).first()).toBeVisible()
        finish(index, 'Payment branch title')
        await expect.poll(async () => (await detail(id)).metadata.summary.text).toBe('Payment branch title')
        await expect(page.getByText('Payment branch title', { exact: true }).first()).toBeVisible()
        expect((await detail(sourceId)).metadata.name).toBe('Current payment discussion')
    })

    test('preserves an explicit rename made while the provider is waiting', async () => {
        titleMode = 'hold'
        const index = titleRequests.length
        const id = await fork()
        await expect.poll(() => titleRequests.length).toBe(index + 1)
        expect((await api.patch(`${base}/api/sessions/${id}`, { data: { name: 'My chosen branch' } })).ok()).toBeTruthy()
        finish(index, 'Late provider result')
        await expect.poll(async () => (await detail(id)).metadata.name).toBe('My chosen branch')
        expect((await detail(id)).metadata.forkTitleSeed).toBeUndefined()
    })

    test('keeps the seed on provider failure and supports manual Generate and Save in the browser', async ({ page }) => {
        titleMode = 'fail'
        const index = titleRequests.length
        const id = await fork()
        await expect.poll(() => titleRequests.length).toBe(index + 1)
        expect((await detail(id)).metadata.summary.text).toBe('Fork: Current payment discussion')
        titleMode = 'success'
        await installHapiAuth(page, base, accessToken)
        await page.goto(`${base}/sessions/${id}`, { waitUntil: 'domcontentloaded' })
        await page.getByRole('button', { name: /More|更多/ }).click()
        await page.getByRole('menuitem', { name: /^(Rename|重命名)$/ }).click()
        const dialog = page.getByRole('dialog')
        await dialog.getByRole('button', { name: /^(Generate|生成)$/ }).click()
        await expect(dialog.getByRole('textbox')).toHaveValue('Generated payment title')
        await dialog.getByRole('button', { name: /^(Save|保存)$/ }).click()
        await expect.poll(async () => (await detail(id)).metadata.summary.text).toBe('Generated payment title')
    })

    test('generates from the historical fork prefix and excludes later source conversation', async () => {
        const boundary = randomUUID()
        const send = await api.post(`${base}/api/sessions/${sourceId}/messages`, {
            data: { text: 'LATER INVENTORY TOPIC MUST BE EXCLUDED', localId: boundary }
        })
        expect(send.ok()).toBeTruthy()
        await expect.poll(async () => (await detail(sourceId)).metadata?.conversationHistoryPoints?.[boundary],
            { timeout: 60_000 }).toBe(true)
        await expect.poll(async () => (await detail(sourceId)).thinking, { timeout: 30_000 }).toBe(false)
        titleMode = 'hold'
        const index = titleRequests.length
        const id = await fork({ messageLocalId: boundary })
        await expect.poll(() => titleRequests.length).toBe(index + 1)
        expect(titleRequests[index]!.prompt).toContain('Discuss payment optimization.')
        expect(titleRequests[index]!.prompt).not.toContain('LATER INVENTORY TOPIC MUST BE EXCLUDED')
        finish(index, 'Historical payment branch')
        await expect.poll(async () => (await detail(id)).metadata.summary.text).toBe('Historical payment branch')
    })

    test('generates for the native terminal fork gateway without a REST fork request', async () => {
        const home = process.env.HAPI_FORK_RUNNER_HOME
        test.skip(!home, 'Requires the isolated task Runner Home')
        const registry = join(home!, 'codex-runtimes')
        const records = await Promise.all((await readdir(registry)).filter(name => name.endsWith('.json'))
            .map(async name => JSON.parse(await readFile(join(registry, name), 'utf8'))))
        const runtime = records.find(record => record.sessions?.[sourceId]?.active)
        expect(runtime).toBeTruthy()
        const WebSocket = createRequire(join(process.cwd(), '../cli/package.json'))('ws')
        const socket = new WebSocket(runtime.endpoint, { headers: {
            Host: 'localhost', Authorization: `Bearer ${runtime.token}`
        } })
        let nextId = 0
        const pending = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>()
        socket.on('message', (raw: Buffer) => {
            const message = JSON.parse(raw.toString())
            const request = pending.get(message.id)
            if (!request || message.method) return
            pending.delete(message.id)
            if (message.error) request.reject(new Error(message.error.message))
            else request.resolve(message.result)
        })
        const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
            const id = ++nextId
            pending.set(id, { resolve, reject })
            socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
        })
        try {
            await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
            await request('initialize', { clientInfo: { name: 'hapi-title-test', title: 'Title test', version: '1' },
                capabilities: { experimentalApi: true } })
            socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }))
            titleMode = 'hold'
            const index = titleRequests.length
            const result = await request('thread/fork', { threadId: runtime.sessions[sourceId].threadId, cwd: directory })
            await expect.poll(() => titleRequests.length).toBe(index + 1)
            const sessions = (await (await api.get(`${base}/api/sessions`)).json()).sessions
            const child = sessions.find((session: any) => session.metadata?.agentSessionId === result.thread.id)
            expect(child).toBeTruthy()
            created.push(child.id)
            const childDetail = await detail(child.id)
            expect(childDetail.metadata.codexSessionId).toBe(result.thread.id)
            expect(childDetail.metadata.summary.text).toBe('Fork: Current payment discussion')
            finish(index, 'Native terminal branch title')
            await expect.poll(async () => (await detail(child.id)).metadata.summary.text).toBe('Native terminal branch title')
            expect(titleRequests.length).toBe(index + 1)
        } finally { socket.terminate() }
    })
})
