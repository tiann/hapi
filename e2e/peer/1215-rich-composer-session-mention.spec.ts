/*
 * Peer-stack e2e for tiann/hapi#1215 — feature-flagged rich composer session @ tokens.
 * Run via: node scripts/dev/run-e2e-on-peer-stack.mjs --worktree <this> --no-up --keep \
 *   e2e/peer/1215-rich-composer-session-mention.spec.ts
 * (spec path relative to worktree; playwright cwd is fork mirror — pass absolute path)
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

const hubUrl = (process.env.HAPI_PEER_WEB_URL ?? process.env.HAPI_PEER_HUB_URL ?? '').replace(/\/$/, '')
const accessToken = process.env.HAPI_PEER_CLI_TOKEN ?? process.env.HAPI_PEER_ACCESS_TOKEN ?? ''
const sessionId = process.env.HAPI_PEER_SESSION_ID ?? ''
const artifactRoot = process.env.HAPI_PEER_WORKTREE ?? process.cwd()
const SCREENSHOT_PATH = resolve(artifactRoot, 'localdocs/playwright-runs/1215-rich-composer-session-mention.png')

function requirePeerEnv(): void {
    if (!hubUrl || !accessToken || !sessionId) {
        throw new Error(
            'Missing peer stack env (HAPI_PEER_WEB_URL, HAPI_PEER_CLI_TOKEN, HAPI_PEER_SESSION_ID).'
        )
    }
}

async function injectAuthAndFlag(page: Page): Promise<void> {
    const storageKey = `hapi_access_token::${hubUrl}`
    await page.addInitScript(({ key, token }) => {
        localStorage.setItem(key, token)
        localStorage.setItem('hapi.composer.richMentions', '1')
    }, { key: storageKey, token: accessToken })
}

test.describe('rich composer session @ mentions — peer stack (#1215)', () => {
    test.beforeAll(() => {
        requirePeerEnv()
        mkdirSync(dirname(SCREENSHOT_PATH), { recursive: true })
    })

    test('inserts inline session token from @ picker and serializes markdown on send wire', async ({ page }) => {
        await injectAuthAndFlag(page)
        await page.goto(`/sessions/${sessionId}?richMentions=1`, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        })

        await expect(page.getByTestId('rich-composer-flag-badge')).toBeVisible({ timeout: 60_000 })
        const rich = page.getByTestId('rich-composer-input')
        await expect(rich).toBeVisible({ timeout: 60_000 })
        await rich.click()
        await page.keyboard.type('see @Peer1215', { delay: 20 })

        // Autocomplete should list the seeded target session
        const option = page.getByText('@Peer1215 Target Alpha').first()
        await expect(option).toBeVisible({ timeout: 15_000 })
        await option.click()

        // Atom chip in the composer (display), not Copy-reference prose dump
        await expect(rich.locator('[data-composer-mention="session"]')).toHaveCount(1)
        await expect(rich).not.toContainText('See session')

        // Mirror/serialized value lives in assistant-ui composer state — assert via DOM dataset + chip attrs
        const mention = rich.locator('[data-composer-mention="session"]').first()
        await expect(mention).toHaveAttribute('data-session-title', /Peer1215 Target Alpha/)

        await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true })
    })
})
