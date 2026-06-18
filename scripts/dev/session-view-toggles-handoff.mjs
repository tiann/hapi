#!/usr/bin/env node
/**
 * Playwright handoff for session header view toggles (files + outline).
 * Usage: node scripts/dev/session-view-toggles-handoff.mjs <sessionId> <cliApiToken> [screenshotPath]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const sessionId = process.argv[2]
const cliToken = process.argv[3]
const screenshotPath = resolve(process.argv[4] ?? 'localdocs/playwright-runs/session-view-toggles-handoff.png')

if (!sessionId || !cliToken) {
    console.error('usage: session-view-toggles-handoff.mjs <sessionId> <cliApiToken> [screenshotPath]')
    process.exit(2)
}

function launchOptions() {
    const chromePath = process.env.PLAYWRIGHT_CHROME_PATH?.trim()
    if (chromePath) return { headless: true, executablePath: chromePath }
    if (process.platform === 'linux' && !process.env.PLAYWRIGHT_BUNDLED_CHROMIUM) {
        return { headless: true, channel: 'chrome' }
    }
    return { headless: true }
}

const baseUrl = 'http://127.0.0.1:3006'
const storageKey = `hapi_access_token::${baseUrl}`
const url = `${baseUrl}/sessions/${sessionId}`
const browser = await chromium.launch(launchOptions())
const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
})
const page = await context.newPage()
await page.addInitScript(({ key, token }) => {
    localStorage.setItem(key, token)
}, { key: storageKey, token: cliToken })
const consoleMessages = []
page.on('console', (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`))
page.on('pageerror', (err) => consoleMessages.push(`pageerror: ${err.message}`))

try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 })

    const login = page.getByPlaceholder('Access token')
    if (await login.isVisible({ timeout: 3000 }).catch(() => false)) {
        await login.fill(cliToken)
        await page.getByRole('button', { name: /sign in|login|connect/i }).click()
        await page.waitForLoadState('networkidle', { timeout: 60000 })
    }

    await page.getByRole('button', { name: 'Files' }).first().waitFor({ state: 'visible', timeout: 60000 })

    // Toggle into files mode — button should become pressed.
    await page.getByRole('button', { name: 'Files' }).first().click()
    await page.getByPlaceholder('Search files').waitFor({ timeout: 30000 })
    await page.getByRole('button', { name: 'Refresh filesystem view' }).waitFor({ timeout: 10000 })

    const filesBtn = page.getByRole('button', { name: 'Return to conversation' })
    await filesBtn.waitFor({ timeout: 5000 })
    const pressed = await filesBtn.getAttribute('aria-pressed')
    if (pressed !== 'true') {
        throw new Error(`Expected files toggle aria-pressed=true, got ${pressed}`)
    }

    mkdirSync(dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: false })

    console.log(JSON.stringify({
        ok: true,
        screenshot: screenshotPath,
        url: page.url().replace(/token=[^&]+/, 'token=<redacted>'),
        filesTogglePressed: pressed,
    }, null, 2))
} catch (error) {
    mkdirSync(dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {})
    console.error(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        screenshot: screenshotPath,
        bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 500),
        consoleMessages,
    }, null, 2))
    process.exitCode = 1
} finally {
    await browser.close()
}
