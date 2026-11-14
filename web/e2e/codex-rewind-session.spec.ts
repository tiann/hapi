import { expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getHapiBaseUrl, installHapiAuth, readCliAccessToken } from './helpers/hapi-live'

// Opt-in: the task Runner must use an isolated Codex home with a local model
// fixture that executes the MAKE_FILE prompt and inspects PROBE_CONTEXT input.
const projectRoot = process.env.HAPI_REWIND_PROJECT_ROOT
test.describe('shared Codex rewind (live)', () => {
    test.skip(process.env.HAPI_LIVE !== '1' || !projectRoot, 'Requires isolated Full environment and local model fixture')
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 412, height: 915 }]) {
        test(`rewinds context while preserving actual generated files and Git (${viewport.width}px)`, async ({ page, request }) => {
            test.setTimeout(180_000)
            const base = getHapiBaseUrl()
            const token = readCliAccessToken()
            const auth = await request.post(`${base}/api/auth`, { data: { accessToken: token } })
            expect(auth.ok()).toBe(true)
            const headers = { Authorization: `Bearer ${(await auth.json()).token}` }
            let machine: { id: string } | undefined
            await expect.poll(async () => {
                const machines = await (await request.get(`${base}/api/machines`, { headers })).json()
                machine = machines.machines.find((m: { active: boolean }) => m.active)
                return Boolean(machine)
            }, { timeout: 60_000 }).toBe(true)
            const cwd = join(projectRoot!, `rewind-${viewport.width}-${randomUUID()}`)
            await mkdir(cwd, { recursive: true })
            await writeFile(join(cwd, 'existing.txt'), 'ORIGINAL\n')
            const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
            git('init', '--quiet'); git('add', 'existing.txt')
            git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture', '--quiet')
            const spawn = await request.post(`${base}/api/machines/${machine!.id}/spawn`, { headers,
                data: { directory: cwd, agent: 'codex', model: 'mock-model', permissionMode: 'yolo' }, timeout: 90_000 })
            const spawned = await spawn.json()
            let sessionId: string = spawned.sessionId
            if (spawned.type === 'error' && /timed out|webhook timeout/i.test(spawned.message ?? '')) {
                // Existing slow-start behavior can lose the machine-RPC reply.
                // Never spawn twice: locate only this fixture's unique cwd.
                test.info().annotations.push({ type: 'setup limitation', description: spawned.message })
                await expect.poll(async () => {
                    const sessions = await (await request.get(`${base}/api/sessions`, { headers })).json()
                    const exact = sessions.sessions.filter((s: { active: boolean; metadata?: { path?: string } }) =>
                        s.active && s.metadata?.path?.replaceAll('\\', '/') === cwd.replaceAll('\\', '/'))
                    expect(exact.length).toBeLessThanOrEqual(1)
                    sessionId = exact[0]?.id
                    return Boolean(sessionId)
                }, { timeout: 90_000 }).toBe(true)
            } else expect(spawned, JSON.stringify(spawned)).toMatchObject({ type: 'success', sessionId: expect.any(String) })
            const send = async (text: string, localId: string) => {
                expect((await request.post(`${base}/api/sessions/${sessionId}/messages`, { headers, data: { text, localId } })).ok()).toBe(true)
            }
            const history = async () => (await (await request.get(`${base}/api/sessions/${sessionId}/messages?limit=200`, { headers })).json()).messages
            try {
                await send('KEEP_PREFIX', 'keep-prefix')
                await expect.poll(async () => JSON.stringify(await history())).toContain('FIXTURE_READY')
                await send('MAKE_FILE_SENTINEL_8F4C', 'file-target')
                await expect.poll(async () => JSON.stringify(await history()), { timeout: 30_000 }).toContain('FILES_CREATED')
                expect(await readFile(join(cwd, 'existing.txt'), 'utf8')).toContain('MODIFIED_8F4C')
                expect(await readFile(join(cwd, 'generated.txt'), 'utf8')).toContain('GENERATED_8F4C')
                git('add', 'existing.txt')
                const snapshot = async () => ({ existing: await readFile(join(cwd, 'existing.txt'), 'hex'),
                    generated: await readFile(join(cwd, 'generated.txt'), 'hex'), head: git('rev-parse', 'HEAD'),
                    status: git('status', '--porcelain'), index: git('ls-files', '--stage') })
                const before = await snapshot()
                await page.setViewportSize(viewport)
                await installHapiAuth(page, base, token)
                await page.addInitScript(() => {
                    for (const feature of ['rich-composer-mentions', 'scratchlist-toggle']) localStorage.setItem(`hapi.fue.v1.${feature}`, '1')
                })
                page.setDefaultTimeout(15_000)
                await page.goto(`${base}/sessions/${sessionId}`, { waitUntil: 'domcontentloaded' })
                const target = page.locator('[data-hapi-message-role="user"]').filter({ hasText: 'MAKE_FILE_SENTINEL_8F4C' })
                await expect(target).toBeVisible()
                await target.hover()
                const rewind = target.getByRole('button', { name: /^(Rewind|回退)$/ })
                await rewind.click()
                const dialog = page.getByRole('dialog')
                await expect(dialog).toContainText(/Files will not be changed|文件不会被修改/)
                await dialog.getByRole('button', { name: /^(Cancel|取消)$/ }).click()
                expect(JSON.stringify(await history())).toContain('MAKE_FILE_SENTINEL_8F4C')
                await target.hover()
                await rewind.click()
                const response = page.waitForResponse(r => r.url().endsWith(`/sessions/${sessionId}/rewind`) && r.request().method() === 'POST')
                await dialog.getByRole('button', { name: /^(Rewind|回退)$/ }).click()
                expect((await response).ok()).toBe(true)
                await expect(target).toHaveCount(0)
                expect(await snapshot()).toEqual(before)
                expect(JSON.stringify(await history())).not.toContain('MAKE_FILE_SENTINEL_8F4C')
                await page.reload()
                await expect(page.getByText('KEEP_PREFIX', { exact: true })).toBeVisible()
                await expect(page.getByText('MAKE_FILE_SENTINEL_8F4C', { exact: true })).toHaveCount(0)
                await send('PROBE_CONTEXT', 'probe-context')
                await expect.poll(async () => JSON.stringify(await history()), { timeout: 30_000 }).toContain('CONTEXT_CLEAN')
                expect(JSON.stringify(await history())).not.toContain('CONTEXT_STILL_HAS_SENTINEL')
                expect(await snapshot()).toEqual(before)
            } finally {
                test.setTimeout(test.info().timeout + 90_000)
                await request.post(`${base}/api/sessions/${sessionId}/archive`, { headers, timeout: 90_000 })
            }
        })
    }
})
