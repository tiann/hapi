#!/usr/bin/env node
/**
 * Playwright handoff capture for the multi-agent session import picker (#732).
 *
 * Opens the sessions index, clicks the import affordance, switches to the
 * Cursor flavor tab (Codex | Cursor | Claude dialog), and writes a full-page PNG.
 *
 * Usage (from repo root, hub serving this branch's embedded web on :3076):
 *   CLI_API_TOKEN=demo-token node scripts/dev/agent-import-picker-handoff.mjs \
 *     --base http://127.0.0.1:3076 \
 *     --token demo-token \
 *     --out localdocs/playwright-runs/agent-import-picker-handoff.png
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function parseArgs(argv) {
    const opts = {
        base: 'http://127.0.0.1:3076',
        token: process.env.CLI_API_TOKEN ?? '',
        out: 'localdocs/playwright-runs/agent-import-picker-handoff.png',
        timeout: 30_000
    }
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--base') opts.base = argv[++i]
        else if (arg === '--token') opts.token = argv[++i]
        else if (arg === '--out') opts.out = argv[++i]
        else if (arg === '--timeout') opts.timeout = Number(argv[++i])
    }
    if (!opts.token) {
        throw new Error('missing --token or CLI_API_TOKEN')
    }
    return opts
}

function launchOptions() {
    const chromePath = process.env.PLAYWRIGHT_CHROME_PATH?.trim()
    if (chromePath) return { headless: true, executablePath: chromePath }
    if (process.platform === 'linux') return { headless: true, channel: 'chrome' }
    return { headless: true }
}

const opts = parseArgs(process.argv.slice(2))
const outPath = resolve(opts.out)
mkdirSync(dirname(outPath), { recursive: true })

const browser = await chromium.launch(launchOptions())
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const consoleMessages = []
const failedRequests = []
page.on('console', (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`))
page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()} ${req.failure()?.errorText ?? ''}`))

try {
    const url = `${opts.base.replace(/\/$/, '')}/sessions?token=${encodeURIComponent(opts.token)}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout })
    await page.waitForTimeout(1500)

    // Import affordance (toolbar button).
    const importButton = page.getByRole('button', { name: /import sessions from another agent/i })
    await importButton.waitFor({ timeout: opts.timeout })
    await importButton.click()

    // Dialog + flavor tabs.
    await page.getByRole('dialog').waitFor({ timeout: opts.timeout })
    await page.getByText('Import sessions').waitFor({ timeout: opts.timeout })
    await page.getByRole('tab', { name: 'Cursor' }).click()

    // Wait for cursor list or loading/empty state inside the dialog.
    await page.getByText(/Loading local Cursor chats|No local Cursor chats|chats selected|Strict ACP-only/i)
        .first()
        .waitFor({ timeout: opts.timeout })

    await page.screenshot({ path: outPath, fullPage: true })

    const bodyText = await page.locator('body').innerText()
    const result = {
        ok: true,
        screenshot: outPath,
        url: page.url().replace(/([?&]token=)[^&]+/g, '$1<redacted>'),
        hasCursorTab: bodyText.includes('Cursor'),
        hasAcpHint: /Strict ACP-only|acp verify-probe/i.test(bodyText),
        consoleMessages,
        failedRequests
    }
    console.log(JSON.stringify(result, null, 2))
    if (failedRequests.length > 0) process.exitCode = 2
} catch (error) {
    await page.screenshot({ path: outPath, fullPage: true }).catch(() => {})
    console.error(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        screenshot: outPath,
        consoleMessages,
        failedRequests
    }, null, 2))
    process.exitCode = 1
} finally {
    await browser.close()
}
