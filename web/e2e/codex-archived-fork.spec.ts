import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installHapiAuth } from './helpers/hapi-live'

const enabled = process.env.HAPI_LIVE === '1' && process.env.HAPI_ARCHIVED_FORK_TEST === '1'
    && Boolean(process.env.HAPI_FORK_TEST_DIR) && Boolean(process.env.HAPI_ACCESS_TOKEN)

for (const mobile of [false, true]) {
    test(`archived Codex session forks without reopening source (${mobile ? 'mobile' : 'desktop'})`, async ({ page, request }, testInfo) => {
        test.skip(!enabled, 'Requires an explicitly isolated Full environment and CODEX_HOME')
        test.setTimeout(480_000)
        const base = process.env.HAPI_FORK_LOCAL_URL ?? process.env.HAPI_URL!
        const runtime = process.env.HAPI_FORK_TEST_DIR!
        const auth = await request.post(`${base}/api/auth`, { data: { accessToken: process.env.HAPI_ACCESS_TOKEN } })
        expect(auth.ok()).toBe(true)
        const headers = { Authorization: `Bearer ${(await auth.json()).token}` }
        const api = async (path: string, data?: unknown) => {
            const response = data === undefined ? await request.get(`${base}/api${path}`, { headers })
                : await request.post(`${base}/api${path}`, { headers, data, timeout: 240_000 })
            expect(response.ok(), `${path}: ${await response.text()}`).toBe(true)
            return response.json()
        }
        const run = randomUUID()
        const retained = `Remembered project context ${run}`
        const excluded = `Alternative requirement ${run}`
        const probe = `Child context probe ${run}`
        const inputs: string[] = []
        const provider = createServer((incoming, response) => {
            const chunks: Buffer[] = []
            incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
            incoming.on('end', () => {
                if (!incoming.url?.endsWith('/responses')) { response.writeHead(404).end(); return }
                const input = Buffer.concat(chunks).toString()
                inputs.push(input)
                const id = randomUUID()
                const text = input.includes(probe) ? 'Branch continued with the retained context.'
                    : input.includes(excluded) ? 'Alternative requirement recorded.' : 'Project context recorded.'
                const events = [
                    { type: 'response.created', response: { id } },
                    { type: 'response.output_item.done', item: { id: `m_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
                    { type: 'response.completed', response: { id, usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } } }
                ]
                response.writeHead(200, { 'Content-Type': 'text/event-stream' })
                response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
            })
        })
        const sessions: string[] = []
        try {
            await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
            const port = (provider.address() as { port: number }).port
            const home = join(runtime, 'codex-home')
            await mkdir(home, { recursive: true })
            await writeFile(join(home, 'config.toml'), `model = "mock-model"\nmodel_provider = "fork_test"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.fork_test]\nname = "Archived fork acceptance"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`)
            const cwd = join(runtime, `work-${run}`)
            await mkdir(cwd, { recursive: true })
            await expect.poll(async () => (await api('/machines')).machines.length, { timeout: 90_000 }).toBe(1)
            const { machines } = await api('/machines')
            const spawn = await api(`/machines/${machines[0].id}/spawn`, { directory: cwd, agent: 'codex', model: 'mock-model', permissionMode: 'read-only' })
            // Source creation is fixture setup. A slow machine can confirm the
            // original reserved row after the general spawn RPC has timed out.
            let source = spawn.type === 'success' ? spawn.sessionId as string : undefined
            if (!source) {
                console.log(`Source fixture startup acknowledgement: ${JSON.stringify(spawn)}`)
                await expect.poll(async () => {
                    const list = await api('/sessions')
                    source = list.sessions.find((session: { id: string; active: boolean; metadata?: { path?: string } }) =>
                        session.active && session.metadata?.path === cwd)?.id
                    return Boolean(source)
                }, { timeout: 90_000 }).toBe(true)
            }
            if (!source) throw new Error('Source fixture did not become ready')
            sessions.push(source)
            const detail = async (id: string) => (await api(`/sessions/${id}`)).session
            const messages = async (id: string) => JSON.stringify(await api(`/sessions/${id}/messages?limit=200`))
            for (const [text, answer] of [[retained, 'Project context recorded.'], [excluded, 'Alternative requirement recorded.']]) {
                await api(`/sessions/${source}/messages`, { localId: text, text })
                await expect.poll(() => messages(source), { timeout: 40_000 }).toContain(answer)
                await expect.poll(async () => (await detail(source)).thinking).toBe(false)
            }
            const originalNative = (await detail(source)).metadata.codexSessionId
            // Windows can report a late wrapper-shutdown error after native
            // archive completed. Require the resulting archived/inactive state.
            const archive = await request.post(`${base}/api/sessions/${source}/archive`, { headers, data: {}, timeout: 150_000 })
            await expect.poll(async () => (await detail(source)).active).toBe(false)
            expect((await detail(source)).metadata.lifecycleState).toBe('archived')
            console.log(`Source archive HTTP status: ${archive.status()}`)
            // Archival can finish before Windows process-stop verification.
            // Establish a responsive Runner before exercising the new feature.
            await expect.poll(async () => {
                try {
                    const ready = await request.post(`${base}/api/machines/${machines[0].id}/paths/exists`,
                        { headers, data: { paths: [cwd] }, timeout: 5_000 })
                    return ready.ok()
                } catch { return false }
            }, { timeout: 90_000, intervals: [2_000] }).toBe(true)
            const originalHistory = await messages(source)
            const requestsBeforeFork = inputs.length
            await installHapiAuth(page, base, process.env.HAPI_ACCESS_TOKEN!)
            await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 })
            await page.goto(`${base}/sessions/${source}`)
            const boundary = page.locator('[data-hapi-message-role="user"]').filter({ hasText: excluded })
            await expect(boundary).toBeVisible()
            const tourDismiss = page.getByRole('button', { name: 'Got it', exact: true })
            if (await tourDismiss.isVisible()) await tourDismiss.click()
            await boundary.hover()
            await expect(boundary.getByRole('button', { name: 'Fork', exact: true })).toBeVisible()
            await expect(boundary.getByRole('button', { name: 'Rewind', exact: true })).toHaveCount(0)
            const screenshots = join(runtime, 'screenshots')
            await mkdir(screenshots, { recursive: true })
            const device = `${testInfo.project.name || 'chromium'}-${mobile ? 'mobile' : 'desktop'}`
            await page.screenshot({ path: join(screenshots, `${device}-01-archived-source.png`) })
            await boundary.getByRole('button', { name: 'Fork', exact: true }).click()
            await page.screenshot({ path: join(screenshots, `${device}-02-confirm-fork.png`) })
            const pending = page.waitForResponse(response => response.url().endsWith(`/sessions/${source}/fork`)
                && response.request().method() === 'POST', { timeout: 240_000 })
            await page.getByRole('dialog').getByRole('button', { name: 'Fork', exact: true }).click()
            const response = await pending
            expect(response.ok(), await response.text()).toBe(true)
            const child = (await response.json()).sessionId as string
            sessions.push(child)
            await expect(page).toHaveURL(new RegExp(`/sessions/${child}$`))
            const childSession = await detail(child)
            expect(childSession.active).toBe(true)
            expect(childSession.metadata.codexSessionId).not.toBe(originalNative)
            expect((await detail(source)).metadata).toMatchObject({ lifecycleState: 'archived', codexSessionId: originalNative })
            expect((await detail(source)).active).toBe(false)
            expect(await messages(source)).toBe(originalHistory)
            expect(inputs).toHaveLength(requestsBeforeFork)
            const childHistory = await messages(child)
            expect(childHistory).toContain(retained)
            expect(childHistory).not.toContain(excluded)
            await api(`/sessions/${child}/messages`, { text: probe, localId: probe })
            await expect.poll(() => messages(child), { timeout: 40_000 }).toContain('Branch continued with the retained context.')
            const childInput = inputs.find(input => input.includes(probe))!
            expect(childInput).toContain(retained)
            expect(childInput).not.toContain(excluded)
            await expect(page.getByText('Branch continued with the retained context.', { exact: true })).toBeVisible()
            await expect.poll(async () => (await detail(child)).thinking).toBe(false)
            for (const dismiss of await page.getByRole('button', { name: 'Dismiss', exact: true }).all()) {
                if (await dismiss.isVisible()) await dismiss.click()
            }
            await page.screenshot({ path: join(screenshots, `${device}-03-independent-child.png`) })
            // A subsequent full-history fork does not reuse the previous branch.
            const full = await api(`/sessions/${source}/fork`, {})
            sessions.push(full.sessionId)
            expect(full.sessionId).not.toBe(child)
            const fullHistory = await messages(full.sessionId)
            expect(fullHistory).toContain(retained)
            expect(fullHistory).toContain(excluded)
            await writeFile(join(runtime, `${device}-archived-fork-evidence.json`), JSON.stringify({ source, sourceNative: originalNative,
                child, childNative: childSession.metadata.codexSessionId, fullChild: full.sessionId,
                sourceArchived: (await detail(source)).metadata.lifecycleState === 'archived', modelCallsDuringFork: 0,
                retainedInherited: childInput.includes(retained), excludedInherited: childInput.includes(excluded) }, null, 2))
        } finally {
            for (const id of sessions.reverse()) await api(`/sessions/${id}/archive`, {}).catch(() => {})
            provider.closeAllConnections()
            await new Promise<void>(resolve => provider.close(() => resolve()))
        }
    })
}
