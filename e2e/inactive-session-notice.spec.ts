import { expect, test } from '@playwright/test'

test.use({ serviceWorkers: 'block' })

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const resumable of [true, false]) {
        test(`inactive notice stays centered at ${viewport.width}px (resumable=${resumable})`, async ({ page }, testInfo) => {
            await page.setViewportSize(viewport)
            await page.addInitScript(() => {
                localStorage.setItem(`hapi_access_token::${location.origin}`, 'inactive-notice-fixture')
                localStorage.setItem('hapi-lang', 'zh-CN')
                localStorage.setItem('hapi-appearance', 'dark')
                localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')
            })
            const errors: string[] = []
            page.on('pageerror', error => errors.push(error.message))
            const session = {
                id: 'inactive-notice-fixture', namespace: 'default', seq: 1,
                createdAt: 1700000000000, updatedAt: 1700000000000,
                active: false, activeAt: 0, thinking: false, thinkingAt: 0,
                metadataVersion: 1, agentStateVersion: 0, agentState: null,
                metadata: {
                    name: '已停止会话提示对齐验证', flavor: 'codex', host: 'fixture',
                    ...(resumable ? { path: '/synthetic/project', codexSessionId: 'synthetic-thread' } : {}),
                },
                model: null, modelReasoningEffort: null, effort: null,
            }
            await page.route(url => url.pathname.startsWith('/api/'), async route => {
                const path = new URL(route.request().url()).pathname
                if (path === '/api/auth') {
                    await route.fulfill({ json: { token: 'synthetic-jwt', user: { id: 1, username: 'fixture' } } })
                } else if (path === '/api/sessions') {
                    await route.fulfill({ json: { sessions: [session] } })
                } else if (path === `/api/sessions/${session.id}`) {
                    await route.fulfill({ json: { session } })
                } else if (path.endsWith('/messages')) {
                    await route.fulfill({ json: {
                        messages: [],
                        page: {
                            direction: 'latest', limit: 20, epoch: 0, reset: false,
                            nextBeforeSeq: null, nextBeforeAt: null,
                            nextAfterSeq: null, nextAfterAt: null,
                            snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false,
                        },
                    } })
                } else if (path.endsWith('/scratchlist')) {
                    await route.fulfill({ json: { entries: [] } })
                } else if (path === '/api/machines') {
                    await route.fulfill({ json: { machines: [] } })
                } else if (path === '/api/events') {
                    await route.fulfill({ contentType: 'text/event-stream', body: ': synthetic fixture\n\n' })
                } else {
                    await route.fulfill({ json: {} })
                }
            })
            await page.goto(`/sessions/${session.id}`)
            const notice = page.getByText(resumable
                ? '此会话已停止。发送消息即可恢复。'
                : '此会话已停止，无法恢复。', { exact: true })
            await expect(notice).toBeVisible()
            await page.screenshot({ path: testInfo.outputPath('inactive-notice.png'), fullPage: true })
            await expect(notice).toHaveCSS('text-align', 'center')
            const geometry = await notice.evaluate(element => {
                const rect = element.getBoundingClientRect()
                const range = document.createRange()
                range.selectNodeContents(element)
                const text = range.getBoundingClientRect()
                return {
                    offset: Math.abs((text.left + text.right) / 2 - (rect.left + rect.right) / 2),
                    overflow: document.documentElement.scrollWidth > window.innerWidth,
                }
            })
            expect(geometry.offset).toBeLessThan(2)
            expect(geometry.overflow).toBe(false)
            expect(errors).toEqual([])
        })
    }
}
