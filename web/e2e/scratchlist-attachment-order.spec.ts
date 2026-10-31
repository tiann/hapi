import { expect, test, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { installHapiAuth } from './helpers/hapi-live'

const enabled = process.env.HAPI_LIVE === '1' && Boolean(process.env.HAPI_ORDER_TEST_DIR) && Boolean(process.env.HAPI_ACCESS_TOKEN)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAPAAAACgCAIAAAC9uXYyAAADjUlEQVR4nO3Zy00rQRBG4QEREZULWwK4UbFD5NI5sbBkWfJlaObpPv/51jymq4+KQX56/fc5SRTPZz+AtCWDFopBC8WghWLQQjFooRi0UAxaKAYtFIMWikELxaCFYtBCMWihGLRQDFooBi0UgxaKQQvFoIVi0EIxaKEYtFAMWigvZz8AUHt77//i+vrY81niGPTRBc9/r32vZNAnRNz5Y417AYN+iI7nf5dl9zPoR0z5v7/arHsY9EOnfMusexj0ACnfMut5Bj1MyrfM+icGPVjKt8z6np8Ujlrz0M+8Hzc0IQtX9ZUbeviaYadYyaBRHTTQWZaJfuVAXn/L/hQmd0Mjaw453YzQoBPuuwWc8V5i0Dk33WJOmht02h23sPNmBZ12u4GnDgo66l5jzx4UtBKkBJ2zosInEBF0yF3+KmEO/KATbrFfo0+DH7SiwIPGL6QFGnom5KDZN7dG406GHLQCYYMGL6FNNOh8sEErEzNo6vrZViNOiRm0YgGDRi6enTTcrIBBKxktaN7K2VtjTYwWtMKhgoYtm8M00NxQQUsGLRRO0KS/m8drlOlxgpYMWjRuaKFAgsa8Ap6oIWYICVq6MGihGLRQDFoohKAZ/808gjb+JAlBS1cGLRSDFopBC8WghWLQQjFooRi0UAxaKAYtFIMWikELxaCFYtBCIQRdXx9nPwJEjT9JQtDSlUELxaCFYtBCgQQN+G/mdIWYISRo6cKghWLQQuEEzXgFPEtRpscJWjJo0aA2NObv5sEKNDdU0BItaNKyOUaxJkYLWuGAQcNWzq4KNytg0ErGDJq3ePZQxCkxg1YsbNDI9bOhgs4HG7QykYOmLqH1ijsZctDsm1us0DOBB600/KDZC+mvij4NftAJt9ipAuYQEXTIXc4LmUBK0AoRFHTIigo/e1DQUfcae+qsoNNud8o7b1zQUXdcMSeNDjrkpivgjPdCg8bfd6FPN+NlCna59fb2PoFUasrpGxpZQIHOsoxBczooxClWin7lwLx+mPKVG3r4MkZ85v24oQde1aZ8z6CHzNqUf2LQg2VtyvMMepisTbmHQQ+QtSn3M+iFbR1Qth0vYNAb1LZh3Ea8kkFvX+Gf+rbgbRn09mz0RH5SKBSDFopBC8WghWLQQjFooRi0UAxaKAYtFIMWikELxaCFYtBCMWihGLRQDFooBi0UgxaKQQvFoIVi0EIxaKEYtCaSb8W55S/DaHpsAAAAAElFTkSuQmCC', 'base64')
type Attachment = { id: string; filename: string; mimeType: string; size: number; path: string }

for (const mobile of [false, true]) {
    test.describe(mobile ? 'touch context' : 'desktop context', () => {
    test.use({ hasTouch: mobile, serviceWorkers: 'block' })
    test(`scratchlist persists attachment order and delivers that order to native Codex (${mobile ? 'touch' : 'desktop'})`, async ({ page, context, request }, testInfo) => {
        test.skip(!enabled, 'Requires isolated Full task environment, explicit local URL and task directory.')
        test.setTimeout(240_000)
        const base = process.env.HAPI_ORDER_LOCAL_URL!
        expect(base).toMatch(/^http:\/\/127\.0\.0\.1:3073$/)
        const directory = process.env.HAPI_ORDER_TEST_DIR!
        const auth = await request.post(`${base}/api/auth`, { data: { accessToken: process.env.HAPI_ACCESS_TOKEN } })
        expect(auth.ok()).toBe(true)
        const headers = { Authorization: `Bearer ${(await auth.json()).token}` }
        const api = async (path: string, data?: unknown, method = 'POST') => {
            const result = await request.fetch(`${base}/api${path}`, { headers, method: data === undefined ? 'GET' : method, data, timeout: 60_000 })
            expect(result.ok(), `${path}: ${await result.text()}`).toBe(true)
            return result.json()
        }
        const modelInputs: unknown[] = []
        const provider = createServer((incoming, response) => {
            const chunks: Buffer[] = []
            incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
            incoming.on('end', () => {
                if (!incoming.url?.endsWith('/responses')) { response.writeHead(404).end(); return }
                modelInputs.push(JSON.parse(Buffer.concat(chunks).toString()))
                const id = randomUUID()
                response.writeHead(200, { 'Content-Type': 'text/event-stream' })
                const event = (body: Record<string, unknown>) => response.write(`event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`)
                event({ type: 'response.created', response: { id } })
                event({ type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg_${id}`, content: [{ type: 'output_text', text: 'ORDER_RECEIVED' }] } })
                event({ type: 'response.completed', response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } })
                response.end()
            })
        })
        let sessionId: string | undefined
        const evidence: unknown[] = []
        try {
            await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
            const port = (provider.address() as { port: number }).port
            const home = join(directory, 'codex-home')
            await mkdir(home, { recursive: true })
            await writeFile(join(home, 'config.toml'), `model = "order-local-model"\nmodel_provider = "order_local"\napproval_policy = "never"\nsandbox_mode = "read-only"\ncheck_for_update_on_startup = false\n[model_providers.order_local]\nname = "Isolated attachment order test"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`)
            const cwd = join(directory, randomUUID())
            await mkdir(cwd, { recursive: true })
            await expect.poll(async () => (await api('/machines')).machines.some((machine: { active: boolean }) => machine.active), { timeout: 30_000 }).toBe(true)
            const machines = (await api('/machines')).machines
            const machine = machines.find((m: { active: boolean }) => m.active)
            expect(machine).toBeTruthy()
            const spawned = await api(`/machines/${machine.id}/spawn`, { directory: cwd, agent: 'codex', model: 'order-local-model', permissionMode: 'read-only' })
            expect(spawned.type, JSON.stringify(spawned)).toBe('success')
            sessionId = spawned.sessionId
            await expect.poll(async () => (await api(`/sessions/${sessionId}`)).session.metadata?.capabilities?.conversationHistory?.forkAtMessage, { timeout: 40_000 }).toBe(true)
            await installHapiAuth(page, base, process.env.HAPI_ACCESS_TOKEN!)
            await page.addInitScript(() => {
                for (const feature of ['scratchlist-toggle', 'rich-composer-mentions']) localStorage.setItem(`hapi.fue.v1.${feature}`, '1')
            })
            await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 })
            const openDrawer = async (target: Page) => {
                await target.goto(`${base}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' })
                const drawer = target.getByTestId('scratchlist-drawer')
                if (!await drawer.isVisible()) await target.getByRole('button', { name: 'Scratchlist drawer', exact: true }).click()
                await expect(drawer).toBeVisible()
            }
            const sibling = await context.newPage()
            const draftEntries = async () => (await api(`/sessions/${sessionId}/scratchlist`)).entries
            const orderedIds = async (entryId: string) => (await draftEntries()).find((e: { entryId: string }) => e.entryId === entryId)?.attachments.map((a: Attachment) => a.id)
            const uiIds = (target: Page) => target.locator('[data-scratchlist-attachment-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-scratchlist-attachment-id')))
            for (const scenario of ['images', 'files', 'mixed', 'scheduled', 'inserted', 'text-only']) {
                const run = randomUUID().slice(0, 8)
                const marker = `ORDER_${scenario}_${run}`
                const attachments: Attachment[] = []
                const initialCount = scenario === 'text-only' ? 0 : scenario === 'inserted' ? 1 : ['mixed', 'scheduled'].includes(scenario) ? 4 : 3
                for (let index = 0; index < initialCount; index++) {
                    const image = scenario === 'images' || ['mixed', 'scheduled'].includes(scenario) && index % 2 === 0
                    const filename = `${run}-${index}-${image ? 'image.png' : 'file.txt'}`
                    const result = await api(`/sessions/${sessionId}/scratchlist/upload`, { filename, mimeType: image ? 'image/png' : 'text/plain', content: image ? png.toString('base64') : Buffer.from(`File ${index}`).toString('base64') })
                    expect(result.success).toBe(true)
                    attachments.push(result.attachment)
                }
                const draft = (await api(`/sessions/${sessionId}/scratchlist`, { text: marker, attachments })).entry
                await openDrawer(page)
                if (scenario === 'inserted' || scenario === 'text-only') {
                    const originalIds = attachments.map(attachment => attachment.id)
                    await page.getByTestId('scratchlist-entry').getByRole('button', { name: 'More actions' }).click()
                    await expect(page.getByRole('menuitem', { name: 'Insert attachments', exact: true })).toBeEnabled()
                    await page.screenshot({ path: testInfo.outputPath(`${scenario}-menu.png`) })
                    const chooser = page.waitForEvent('filechooser')
                    await page.getByRole('menuitem', { name: 'Insert attachments', exact: true }).click()
                    await (await chooser).setFiles([
                        { name: `${run}-added-image.png`, mimeType: 'image/png', buffer: png },
                        { name: `${run}-added-file.txt`, mimeType: 'text/plain', buffer: Buffer.from('Inserted file') },
                    ])
                    await expect.poll(async () => (await draftEntries()).find((entry: { entryId: string }) => entry.entryId === draft.entryId)?.attachments.length).toBe(initialCount + 2)
                    const persisted = (await draftEntries()).find((entry: { entryId: string }) => entry.entryId === draft.entryId)
                    expect(persisted.text).toBe(marker)
                    expect(persisted.attachments.slice(0, initialCount).map((attachment: Attachment) => attachment.id)).toEqual(originalIds)
                    expect(persisted.attachments.slice(initialCount).map((attachment: Attachment) => attachment.filename)).toEqual([`${run}-added-image.png`, `${run}-added-file.txt`])
                    attachments.splice(0, attachments.length, ...persisted.attachments)
                    await expect(page.getByTestId('scratchlist-drawer')).toBeVisible()
                    await page.getByTestId('scratchlist-drawer').screenshot({ path: testInfo.outputPath(`${scenario}-uploaded.png`) })
                }
                await expect(page.locator('[data-scratchlist-attachment-id]')).toHaveCount(attachments.length)
                const first = attachments[0]!
                await page.getByRole('button', { name: `Reorder attachment ${first.filename}`, exact: true }).press('End')
                const expected = [...attachments.slice(1), first]
                await expect.poll(() => orderedIds(draft.entryId)).toEqual(expected.map(a => a.id))
                await expect.poll(() => uiIds(page)).toEqual(expected.map(a => a.id))
                // A separate page mounts from the real Hub; no fixture/localStorage seeding.
                await openDrawer(sibling)
                await expect.poll(() => uiIds(sibling)).toEqual(expected.map(a => a.id))
                // Clear all browser storage and reload, proving the server is canonical.
                await page.evaluate(() => localStorage.clear())
                await page.reload({ waitUntil: 'domcontentloaded' })
                if (!await page.getByTestId('scratchlist-drawer').isVisible()) await page.getByRole('button', { name: 'Scratchlist drawer', exact: true }).click()
                await expect.poll(() => uiIds(page)).toEqual(expected.map(a => a.id))
                // Reorder on the second page and verify SSE updates the first page.
                await sibling.getByRole('button', { name: `Reorder attachment ${first.filename}`, exact: true }).press('Home')
                await expect.poll(() => orderedIds(draft.entryId)).toEqual(attachments.map(a => a.id))
                await expect.poll(() => uiIds(page)).toEqual(attachments.map(a => a.id))
                // Exchange again before sending to avoid relying on the original upload order.
                await page.getByRole('button', { name: `Reorder attachment ${first.filename}`, exact: true }).press('End')
                await expect.poll(() => orderedIds(draft.entryId)).toEqual(expected.map(a => a.id))
                if (scenario === 'files') {
                    // A rejected persistence request must restore both UI and Hub order.
                    await page.route(`**/api/sessions/${sessionId}/scratchlist/${draft.entryId}`, route => route.fulfill({ status: 503, json: { error: 'Induced order save failure' } }), { times: 1 })
                    await page.getByRole('button', { name: `Reorder attachment ${first.filename}`, exact: true }).press('Home')
                    await expect(page.getByRole('alert')).toBeVisible()
                    await expect.poll(() => uiIds(page)).toEqual(expected.map(a => a.id))
                    expect(await orderedIds(draft.entryId)).toEqual(expected.map(a => a.id))
                    // A subsequent successful edit clears the error and remains durable.
                    await page.getByRole('button', { name: `Reorder attachment ${first.filename}`, exact: true }).press('Home')
                    await expect.poll(() => orderedIds(draft.entryId)).toEqual(attachments.map(a => a.id))
                    await expect(page.getByRole('button', { name: `Reorder attachment ${first.filename}`, exact: true })).toBeEnabled()
                    await page.getByRole('button', { name: `Reorder attachment ${first.filename}`, exact: true }).press('End')
                    await expect.poll(() => orderedIds(draft.entryId)).toEqual(expected.map(a => a.id))
                }
                await page.getByTestId('scratchlist-drawer').screenshot({ path: testInfo.outputPath(`${scenario}-saved.png`) })
                const payloads: { attachments?: Attachment[]; text: string }[] = []
                const recordMessage = (request: import('@playwright/test').Request) => {
                    if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/sessions/${sessionId}/messages`) payloads.push(request.postDataJSON())
                }
                page.on('request', recordMessage)
                if (scenario === 'mixed') {
                    // Staging fails before any send. The original durable draft must remain.
                    let stagingFailed = false
                    await page.route(`**/api/sessions/${sessionId}/upload`, async route => {
                        stagingFailed = true
                        await route.fulfill({ status: 503, json: { error: 'Induced staging failure' } })
                    }, { times: 1 })
                    await page.getByTestId('scratchlist-entry').getByRole('button', { name: 'More actions' }).click()
                    await page.getByRole('menuitem', { name: 'Send now', exact: true }).click()
                    await expect.poll(() => stagingFailed).toBe(true)
                    await expect(page.getByRole('menuitem', { name: 'Send now', exact: true })).toHaveCount(0)
                    await expect(page.getByTestId('scratchlist-entry').getByRole('button', { name: 'More actions' })).toBeEnabled()
                    expect(payloads).toHaveLength(0)
                    expect(await orderedIds(draft.entryId)).toEqual(expected.map(a => a.id))
                    await expect(page.getByTestId('scratchlist-entry')).toBeVisible()
                    await page.keyboard.press('Escape')
                }
                await page.getByTestId('scratchlist-entry').getByRole('button', { name: 'More actions' }).click()
                if (scenario === 'scheduled') {
                    await page.getByRole('menuitem', { name: 'Schedule send', exact: true }).click()
                    const picker = page.getByRole('dialog', { name: 'Schedule send', exact: true })
                    await picker.getByRole('button', { name: 'Specific', exact: true }).click()
                    const when = new Date(Date.now() + 15_000)
                    const pad = (n: number) => String(n).padStart(2, '0')
                    await picker.locator('input[type="datetime-local"]').fill(`${when.getFullYear()}-${pad(when.getMonth()+1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`)
                    await picker.getByRole('button', { name: 'Schedule send', exact: true }).click()
                } else {
                    await page.getByRole('menuitem', { name: 'Send now', exact: true }).click()
                }
                await expect.poll(() => payloads.length).toBe(1)
                if (scenario !== 'scheduled') {
                    await expect(page.getByTestId('scratchlist-drawer')).toHaveCount(0)
                    await expect(page.getByRole('button', { name: 'Scratchlist drawer', exact: true })).toHaveAttribute('aria-pressed', 'false')
                }
                expect(payloads[0]!.attachments!.map(a => a.id)).toEqual(expected.map(a => a.id))
                if (scenario === 'scheduled') expect(payloads[0]!.attachments!.every(a => a.path.startsWith('hapi-hub:scratchlist/'))).toBe(true)
                // Capture native model input, not a mocked HAPI send callback.
                await expect.poll(() => modelInputs.some(input => JSON.stringify(input).includes(marker)), { timeout: 45_000 }).toBe(true)
                const native = modelInputs.find(input => JSON.stringify(input).includes(marker)) as { input: { role?: string; content?: unknown }[] }
                const user = native.input.filter(item => item.role === 'user' && JSON.stringify(item).includes(marker)).at(-1)
                expect(user).toBeTruthy()
                const text = JSON.stringify(user)
                const offsets = expected.map(a => text.indexOf(a.filename))
                expect(offsets.every(value => value >= 0)).toBe(true)
                expect(offsets).toEqual([...offsets].sort((a, b) => a - b))
                await expect.poll(async () => (await draftEntries()).some((e: { entryId: string }) => e.entryId === draft.entryId), { timeout: 30_000 }).toBe(false)
                const messages = await api(`/sessions/${sessionId}/messages?limit=200`)
                expect(JSON.stringify(messages)).toContain(marker)
                const raw = (messages as { messages: { content: unknown }[] }).messages
                const savedMessage = raw.find(message => JSON.stringify(message.content).includes(marker))
                expect(savedMessage).toBeTruthy()
                const savedOrder: string[] = []
                const collect = (value: unknown) => {
                    if (value && typeof value === 'object') {
                        const object = value as Record<string, unknown>
                        if (Array.isArray(object.attachments)) savedOrder.push(...(object.attachments as Attachment[]).map(a => a.id))
                        for (const child of Object.values(object)) collect(child)
                    }
                }
                collect(savedMessage!.content)
                expect(savedOrder).toEqual(expected.map(a => a.id))
                evidence.push({ scenario, draft: draft.entryId, selected: expected.map(a => a.filename), outgoing: payloads[0]!.attachments!.map(a => a.filename), savedMessageOrder: savedOrder, nativeOffsets: offsets, crossPageAndClearedStorage: true, failedSaveRollback: scenario === 'files', failedStagingRetainsDraft: scenario === 'mixed', insertedThroughSystemPicker: ['inserted', 'text-only'].includes(scenario), drawerClosedAfterImmediateSend: scenario !== 'scheduled' })
                await expect.poll(async () => (await api(`/sessions/${sessionId}`)).session.thinking, { timeout: 30_000 }).toBe(false)
                const bubble = page.locator('[data-hapi-message-role="user"]').filter({ hasText: marker }).last()
                await expect(bubble).toBeVisible()
                const displayNames = await bubble.evaluate((element, filenames) => {
                    const wanted = new Set(filenames)
                    return Array.from(element.querySelectorAll('span, div'))
                        .filter(node => node.children.length === 0 && wanted.has(node.textContent?.trim() ?? '') && getComputedStyle(node).position !== 'absolute')
                        .map(node => node.textContent!.trim())
                }, expected.map(a => a.filename))
                expect(displayNames).toEqual(expected.map(a => a.filename))
                await bubble.screenshot({ path: testInfo.outputPath(`${scenario}-sent.png`) })
                if (scenario === 'text-only') await page.screenshot({ path: testInfo.outputPath('send-now-drawer-closed.png') })
                page.off('request', recordMessage)
                await expect.poll(async () => (await api(`/sessions/${sessionId}`)).session.thinking, { timeout: 30_000 }).toBe(false)
            }
            await sibling.close()
            await writeFile(join(directory, `evidence-${mobile ? 'touch' : 'desktop'}.json`), JSON.stringify(evidence, null, 2))
            await testInfo.attach('order-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
        } finally {
            if (sessionId) await api(`/sessions/${sessionId}/archive`, {}).catch(() => {})
            provider.closeAllConnections()
            await new Promise<void>(resolve => provider.close(() => resolve()))
        }
    })
    })
}
