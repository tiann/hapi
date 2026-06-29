/*
 * Peer-stack e2e for tiann/hapi#980 — searchable session picker on /share.
 * Requires localdocs/peer-stack.env (from hapi-peer-stack up).
 */

import { mkdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

const hubUrl = (process.env.HAPI_PEER_WEB_URL ?? process.env.HAPI_PEER_HUB_URL ?? '').replace(/\/$/, '')
const accessToken = process.env.HAPI_PEER_CLI_TOKEN ?? process.env.HAPI_PEER_ACCESS_TOKEN ?? ''

const SCREENSHOT_PATH = resolve('localdocs/playwright-runs/share-target-session-search.png')
const INACTIVE_SESSION_TITLE = 'Zeppelin Archive Peer980'

function requirePeerEnv(): void {
    if (!hubUrl || !accessToken) {
        throw new Error(
            'Missing peer stack env. Run hapi-peer-stack up then export vars from localdocs/peer-stack.env '
            + 'or use scripts/dev/run-e2e-on-peer-stack.mjs when available.'
        )
    }
}

async function createInactiveSession(title: string): Promise<string> {
    const res = await fetch(`${hubUrl}/cli/sessions`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            tag: `peer980-inactive-${Date.now()}`,
            metadata: {
                path: '/tmp/zeppelin-archive-peer980',
                host: hostname(),
                flavor: 'cursor',
                name: title,
            },
            agentState: { requests: {}, completedRequests: {} },
        }),
    })
    if (!res.ok) {
        throw new Error(`POST /cli/sessions failed (${res.status}): ${await res.text()}`)
    }
    const data = await res.json() as { session?: { id?: string } }
    const sessionId = data.session?.id
    if (!sessionId) {
        throw new Error(`unexpected /cli/sessions response: ${JSON.stringify(data)}`)
    }
    return sessionId
}

async function injectAuth(page: Page): Promise<void> {
    const storageKey = `hapi_access_token::${hubUrl}`
    await page.addInitScript(({ key, token }) => {
        localStorage.setItem(key, token)
    }, { key: storageKey, token: accessToken })
}

async function seedShareTransfer(page: Page, transferId: string): Promise<void> {
    await page.evaluate(async ({ id }) => {
        const payload = {
            title: 'Peer stack share search test',
            text: 'Attach this note via searchable session picker',
            url: '',
            files: [] as Array<{ name: string; type: string; blob: Blob }>,
            createdAt: Date.now(),
        }
        await new Promise<void>((resolve, reject) => {
            const request = indexedDB.open('hapi-share-transfers', 1)
            request.onupgradeneeded = () => {
                const db = request.result
                if (!db.objectStoreNames.contains('transfers')) {
                    db.createObjectStore('transfers', { keyPath: 'id' })
                }
            }
            request.onsuccess = () => {
                const db = request.result
                const tx = db.transaction('transfers', 'readwrite')
                tx.objectStore('transfers').put({ id, ...payload })
                tx.oncomplete = () => {
                    db.close()
                    resolve()
                }
                tx.onerror = () => {
                    db.close()
                    reject(tx.error ?? new Error('share-transfer put failed'))
                }
            }
            request.onerror = () => reject(request.error ?? new Error('IDB open failed'))
        })
    }, { id: transferId })
}

test.describe('share target session search — peer stack (#980)', () => {
    test.beforeAll(() => {
        requirePeerEnv()
    })

    test('search finds inactive session on real /share picker', async ({ page }) => {
        await createInactiveSession(INACTIVE_SESSION_TITLE)

        const transferId = `peer980-${Date.now()}`
        await injectAuth(page)
        await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await seedShareTransfer(page, transferId)

        await page.goto(`/share?id=${encodeURIComponent(transferId)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        })

        await expect(page.getByText('Share to HAPI')).toBeVisible({ timeout: 60_000 })
        await expect(page.getByText('Attach this note via searchable session picker')).toBeVisible()

        const search = page.getByPlaceholder('Search sessions…')
        await search.waitFor({ state: 'visible', timeout: 30_000 })

        await search.fill('zeppelin')
        await expect(page.getByRole('button', { name: new RegExp(INACTIVE_SESSION_TITLE) }).first()).toBeVisible({ timeout: 30_000 })
        await expect(page.getByText('Matching sessions')).toBeVisible()

        mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true })
        await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false })
    })
})
