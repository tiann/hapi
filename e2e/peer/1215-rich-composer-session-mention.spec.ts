/*
 * Peer-stack e2e + annotated screencast for tiann/hapi#1215.
 * Rich composer is ON by default (no user opt-in). Covers chips + baseline
 * composer behaviors in one motion proof.
 */

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
// Fork tooling lives on the mirror; worktrees from upstream tip may lack scripts/dev.
import {
    annotatedVideoPaths,
    startAnnotatedScreencast,
    stopAnnotatedScreencast,
} from '/home/heavygee/coding/hapi/scripts/dev/playwright-annotated-video.mjs'

const hubUrl = (process.env.HAPI_PEER_WEB_URL ?? process.env.HAPI_PEER_HUB_URL ?? '').replace(/\/$/, '')
const accessToken = process.env.HAPI_PEER_CLI_TOKEN ?? process.env.HAPI_PEER_ACCESS_TOKEN ?? ''
const sessionId = process.env.HAPI_PEER_SESSION_ID ?? ''
const artifactRoot = process.env.HAPI_PEER_WORKTREE ?? process.cwd()
const RUNS = resolve(artifactRoot, 'localdocs/playwright-runs')
const { webm: WEBM_PATH, mp4: MP4_PATH } = annotatedVideoPaths(RUNS, '1215-rich-composer-dogfood')

function requirePeerEnv(): void {
    if (!hubUrl || !accessToken || !sessionId) {
        throw new Error(
            'Missing peer stack env (HAPI_PEER_WEB_URL, HAPI_PEER_CLI_TOKEN, HAPI_PEER_SESSION_ID).'
        )
    }
}

async function injectAuth(page: Page): Promise<void> {
    const storageKey = `hapi_access_token::${hubUrl}`
    await page.addInitScript(({ key, token }) => {
        localStorage.setItem(key, token)
        // Product default is ON — clear any leftover kill-switch from prior dogfood.
        localStorage.removeItem('hapi.composer.richMentions')
    }, { key: storageKey, token: accessToken })
}

async function pickSessionMention(page: Page, query: string, label: string): Promise<void> {
    const rich = page.getByTestId('rich-composer-input')
    await rich.click()
    await page.keyboard.type(query, { delay: 25 })
    const option = page.getByText(label).first()
    await expect(option).toBeVisible({ timeout: 15_000 })
    await option.click()
}

test.describe('rich composer session @ mentions — peer stack (#1215)', () => {
    test.beforeAll(() => {
        requirePeerEnv()
        mkdirSync(RUNS, { recursive: true })
    })

    test('motion proof: chips + composer baseline still works', async ({ page }) => {
        test.setTimeout(90_000)
        await injectAuth(page)
        await page.goto(`/sessions/${sessionId}`, {
            waitUntil: 'domcontentloaded',
            timeout: 60_000,
        })

        const rich = page.getByTestId('rich-composer-input')
        await expect(rich).toBeVisible({ timeout: 60_000 })

        await startAnnotatedScreencast(page, {
            path: WEBM_PATH,
            size: { width: 1440, height: 900 },
        })

        // 1) Mid-message session chip (not prose dump)
        await page.keyboard.type('compare ', { delay: 20 })
        await pickSessionMention(page, '@Peer1215', '@Peer1215 Target Alpha')
        await expect(rich.locator('[data-composer-mention="session"]')).toHaveCount(1)
        await expect(rich).not.toContainText('See session')

        // 2) Second mention mid-prose
        await page.keyboard.type('vs ', { delay: 20 })
        await pickSessionMention(page, '@Peer1215', '@Peer1215 Target Alpha')
        await expect(rich.locator('[data-composer-mention="session"]')).toHaveCount(2)

        // 3) Backspace deletes whole trailing atom
        await page.keyboard.press('Backspace') // trailing space after second chip
        await page.keyboard.press('Backspace') // whole chip
        await expect(rich.locator('[data-composer-mention="session"]')).toHaveCount(1)

        // 4) Slash command still plain-text inserts (not chipped)
        await page.keyboard.type(' then /hel', { delay: 20 })
        const slash = page.getByText('/help').first()
        if (await slash.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await slash.click()
            await expect(rich).toContainText('/help')
            await expect(rich.locator('[data-composer-mention="session"]')).toHaveCount(1)
        } else {
            // Peer seed may lack slash catalog — type a plain slash token instead.
            await page.keyboard.press('Escape')
            await page.keyboard.type('p ', { delay: 15 })
            await expect(rich).toContainText('/help')
        }

        // 5) Shift+Enter must create a real newline (not same-line wrap).
        // toContainText collapses whitespace — assert innerText instead.
        await page.keyboard.press('Shift+Enter')
        await page.waitForTimeout(350)
        await page.keyboard.type('line two still editable', { delay: 15 })
        await expect.poll(async () => rich.innerText()).toMatch(
            /line two still editable/
        )
        await expect.poll(async () => rich.innerText()).toContain('\n')

        // 6) Clear + multiline send (Shift+Enter then Enter-to-send)
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Backspace')
        await page.keyboard.type('rich composer line one', { delay: 15 })
        await page.keyboard.press('Shift+Enter')
        await page.waitForTimeout(250)
        await page.keyboard.type('rich composer line two', { delay: 15 })
        await expect.poll(async () => rich.innerText()).toBe(
            'rich composer line one\nrich composer line two'
        )
        await page.keyboard.press('Enter')
        await expect(page.getByText(/rich composer line one/).first()).toBeVisible({
            timeout: 20_000,
        })
        await expect(page.getByText(/rich composer line two/).first()).toBeVisible({
            timeout: 10_000,
        })

        await stopAnnotatedScreencast(page)
    })
})

export { MP4_PATH, WEBM_PATH }
