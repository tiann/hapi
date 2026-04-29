#!/usr/bin/env node
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function parseArgs(argv) {
    const args = { expects: [], timeout: 15000, out: '', screenshot: '' }
    const positional = []
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--expect' || arg === '--wait-text') {
            args.expects.push(argv[++i])
        } else if (arg === '--timeout') {
            args.timeout = Number(argv[++i])
        } else if (arg === '--out') {
            args.out = argv[++i]
        } else if (arg === '--screenshot') {
            args.screenshot = argv[++i]
        } else {
            positional.push(arg)
        }
    }
    if (!positional[0]) {
        throw new Error('usage: read-hapi-web.mjs <url> [--expect TEXT] [--out FILE] [--screenshot FILE] [--timeout MS]')
    }
    return { ...args, url: positional[0] }
}

const args = parseArgs(process.argv.slice(2))
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const consoleMessages = []
const failedRequests = []
page.on('console', (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`))
page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`))

try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: args.timeout })
    for (const expected of args.expects) {
        await page.getByText(expected, { exact: false }).first().waitFor({ timeout: args.timeout })
    }
    const text = await page.locator('body').innerText({ timeout: args.timeout }).catch(async () => await page.textContent('body') ?? '')
    const html = await page.locator('body').evaluate((node) => node.innerHTML).catch(() => '')
    const result = {
        ok: args.expects.every((expected) => text.includes(expected)),
        url: page.url().replace(/([?&]token=)[^&]+/g, '$1<redacted>'),
        title: await page.title(),
        text,
        textLength: text.length,
        htmlLength: html.length,
        expects: args.expects.map((expected) => ({ text: expected, found: text.includes(expected) })),
        consoleMessages,
        failedRequests
    }
    if (args.out) {
        const out = resolve(args.out)
        mkdirSync(dirname(out), { recursive: true })
        writeFileSync(out, text)
    }
    if (args.screenshot) {
        const screenshot = resolve(args.screenshot)
        mkdirSync(dirname(screenshot), { recursive: true })
        await page.screenshot({ path: screenshot, fullPage: true })
        result.screenshot = screenshot
    }
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 2
} catch (error) {
    if (args.screenshot) {
        const screenshot = resolve(args.screenshot)
        mkdirSync(dirname(screenshot), { recursive: true })
        await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {})
    }
    console.error(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        url: page.url().replace(/([?&]token=)[^&]+/g, '$1<redacted>'),
        consoleMessages,
        failedRequests
    }, null, 2))
    process.exitCode = 1
} finally {
    await browser.close()
}
