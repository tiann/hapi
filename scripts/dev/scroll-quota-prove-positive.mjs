#!/usr/bin/env node
/**
 * Positive repro: prove upstream scroll guard fails under quota while fixed code survives.
 * Runs async scroll-key writes after filling sessionStorage (TanStack-like timing).
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SCROLL_KEY = 'tsr-scroll-restoration-v1_3'
const BASE_URL = process.env.HAPI_URL ?? 'http://127.0.0.1:3007'
const ACCESS_TOKEN = process.env.HAPI_ACCESS_TOKEN ?? ''
const LABEL = process.env.HAPI_VARIANT ?? 'unknown'
const OUT_DIR = resolve('localdocs/playwright-runs')

function parseArgs(argv) {
    const args = { sessionId: '', fillMb: 5.0, routes: 200 }
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--session') args.sessionId = argv[++i]
        else if (argv[i] === '--fill-mb') args.fillMb = Number(argv[++i])
        else if (argv[i] === '--routes') args.routes = Number(argv[++i])
    }
    return args
}

const args = parseArgs(process.argv.slice(2))
mkdirSync(OUT_DIR, { recursive: true })
const outJson = resolve(OUT_DIR, `scroll-quota-positive-${LABEL}-${Date.now()}.json`)

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH ?? '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext()
if (ACCESS_TOKEN) {
    await context.addInitScript(({ token, baseUrl }) => {
        localStorage.setItem(`hapi_access_token::${baseUrl}`, token)
    }, { token: ACCESS_TOKEN, baseUrl: BASE_URL })
}

const page = await context.newPage()
const pageErrors = []
const consoleErrors = []
page.on('pageerror', (err) => pageErrors.push(String(err)))
page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
})

const path = args.sessionId ? `/sessions/${args.sessionId}` : '/sessions'
await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(2500)

const guardInstalled = await page.evaluate(() => Boolean(sessionStorage.__hapiScrollRestorationGuard))

// Fill storage until quota, leaving scroll key for last-mile pressure
const fill = await page.evaluate((fillMb) => {
    const chunk = 'y'.repeat(256 * 1024)
    const target = fillMb * 1024 * 1024
    let added = 0
    let i = 0
    const errors = []
    while (added < target) {
        try {
            sessionStorage.setItem(`__fill_${i}`, chunk)
            added += chunk.length
            i += 1
        } catch (e) {
            errors.push(String(e))
            break
        }
    }
    return { keys: i, mb: added / (1024 * 1024), errors }
}, args.fillMb)

function buildPayload(routeCount) {
    const state = {}
    for (let i = 0; i < routeCount; i += 1) {
        state[`/sessions/stress-${i}`] = {
            window: { scrollX: 0, scrollY: i * 19 },
            'main:nth-child(1)': { scrollX: 0, scrollY: i * 13 },
        }
    }
    return JSON.stringify(state)
}

// Phase A: TanStack-like async scroll persists
const asyncWrites = await page.evaluate(({ scrollKey, routes }) => {
    const payload = (() => {
        const state = {}
        for (let i = 0; i < routes; i += 1) {
            state[`/sessions/stress-${i}`] = {
                window: { scrollX: 0, scrollY: i * 19 },
                'main:nth-child(1)': { scrollX: 0, scrollY: i * 13 },
            }
        }
        return JSON.stringify(state)
    })()

    return new Promise((resolve) => {
        const result = { scheduled: 0, syncThrows: [] }
        window.__scrollQuotaPositive = { pageErrors: [] }
        const onErr = (ev) => {
            result.pageErrors = result.pageErrors ?? []
            result.pageErrors.push(String(ev.error ?? ev.message))
        }
        window.addEventListener('error', onErr)

        for (let n = 0; n < 25; n += 1) {
            result.scheduled += 1
            setTimeout(() => {
                try {
                    sessionStorage.setItem(scrollKey, payload)
                } catch (e) {
                    result.syncThrows.push(String(e))
                }
            }, n * 8)
        }

        setTimeout(() => {
            window.removeEventListener('error', onErr)
            resolve(result)
        }, 400)
    })
}, { scrollKey: SCROLL_KEY, routes: args.routes })

await page.waitForTimeout(300)

// Phase B: explicit #707 unwrap-window simulation (positive control for broken pattern)
const unwrapRace = await page.evaluate((scrollKey) => {
    return new Promise((resolve) => {
        const windowErrors = []
        const onErr = (ev) => windowErrors.push(String(ev.error ?? ev.message))
        window.addEventListener('error', onErr)

        const wrapped = sessionStorage.setItem
        const native = Storage.prototype.setItem.bind(sessionStorage)
        sessionStorage.setItem = native

        for (let i = 0; i < 12; i += 1) {
            setTimeout(() => {
                try {
                    const state = {}
                    for (let r = 0; r < 120; r += 1) {
                        state[`/race/${i}/${r}`] = { window: { scrollX: 0, scrollY: r } }
                    }
                    sessionStorage.setItem(scrollKey, JSON.stringify(state))
                } catch {
                    // sync catch — window 'error' is what we care about (TanStack async path)
                }
            }, i * 5)
        }

        setTimeout(() => {
            sessionStorage.setItem = wrapped
            window.removeEventListener('error', onErr)
            resolve({ windowErrors })
        }, 250)
    })
}, SCROLL_KEY)

await page.waitForTimeout(200)

const scrollKeyAfter = await page.evaluate((scrollKey) => {
    const v = sessionStorage.getItem(scrollKey)
    return v ? { bytes: v.length, routes: Object.keys(JSON.parse(v)).length } : { bytes: 0, routes: 0 }
}, SCROLL_KEY)

const quotaSignals = [
    ...pageErrors.filter((t) => /QuotaExceeded|tsr-scroll-restoration/i.test(t)),
    ...consoleErrors.filter((t) => /QuotaExceeded|tsr-scroll-restoration/i.test(t)),
    ...(asyncWrites.pageErrors ?? []).filter((t) => /QuotaExceeded|tsr-scroll-restoration/i.test(t)),
    ...(unwrapRace.windowErrors ?? []).filter((t) => /QuotaExceeded|tsr-scroll-restoration/i.test(t)),
]

const result = {
    label: LABEL,
    url: BASE_URL,
    guardInstalled,
    fill,
    asyncWrites,
    unwrapRace,
    scrollKeyAfter,
    pageErrors,
    quotaSignals,
    bugReproduced: quotaSignals.length > 0,
    survived: quotaSignals.length === 0,
}

writeFileSync(outJson, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
await browser.close()
process.exitCode = result.bugReproduced ? 0 : 1
