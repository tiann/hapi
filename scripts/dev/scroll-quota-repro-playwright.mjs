#!/usr/bin/env node
/**
 * Stress-test TanStack scroll restoration against live HAPI.
 * Fills sessionStorage toward quota, seeds oversized scroll map, scrolls + navigates.
 *
 * Usage:
 *   HAPI_URL=http://127.0.0.1:3006 HAPI_ACCESS_TOKEN=... \
 *     node scripts/dev/scroll-quota-repro-playwright.mjs --session <id> --fill-mb 4.5 --scroll-routes 200
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE_URL = process.env.HAPI_URL ?? 'https://hapi.tail9944ee.ts.net'
const ACCESS_TOKEN = process.env.HAPI_ACCESS_TOKEN ?? ''
const OUT_DIR = resolve('localdocs/playwright-runs')
const SCROLL_KEY = 'tsr-scroll-restoration-v1_3'

function parseArgs(argv) {
    const args = { sessionId: '', fillMb: 4.5, scrollRoutes: 200, timeout: 60000, navRounds: 6 }
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--session') args.sessionId = argv[++i]
        else if (arg === '--fill-mb') args.fillMb = Number(argv[++i])
        else if (arg === '--scroll-routes') args.scrollRoutes = Number(argv[++i])
        else if (arg === '--timeout') args.timeout = Number(argv[++i])
        else if (arg === '--nav-rounds') args.navRounds = Number(argv[++i])
    }
    return args
}

const args = parseArgs(process.argv.slice(2))
mkdirSync(OUT_DIR, { recursive: true })
const stamp = Date.now()
const outJson = resolve(OUT_DIR, `scroll-quota-${stamp}.json`)
const outPng = resolve(OUT_DIR, `scroll-quota-${stamp}.png`)

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROME_PATH ?? '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })

if (ACCESS_TOKEN) {
    await context.addInitScript(({ token, baseUrl }) => {
        localStorage.setItem(`hapi_access_token::${baseUrl}`, token)
    }, { token: ACCESS_TOKEN, baseUrl: BASE_URL })
}

const page = await context.newPage()
const consoleMessages = []
const pageErrors = []

page.on('console', (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() })
})
page.on('pageerror', (err) => {
    pageErrors.push(String(err))
})

const targetPath = args.sessionId ? `/sessions/${args.sessionId}` : '/sessions'
const url = `${BASE_URL}${targetPath}`

try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: args.timeout })
    await page.waitForTimeout(3000)

    const guardInstalled = await page.evaluate(() => {
        return Boolean(window.sessionStorage.__hapiScrollRestorationGuard)
    })

    const signedIn = await page.evaluate(() => {
        return !document.body.innerText.includes('Sign In')
    })

    // Seed oversized scroll restoration map (simulates long session history)
    const scrollSeed = await page.evaluate(({ scrollRoutes, scrollKey }) => {
        const state = {}
        for (let i = 0; i < scrollRoutes; i += 1) {
            state[`/sessions/route-${i}`] = {
                window: { scrollX: 0, scrollY: i * 17 },
                'html:nth-child(1)': { scrollX: 0, scrollY: i * 13 },
            }
        }
        const json = JSON.stringify(state)
        let threw = false
        let error = ''
        try {
            window.sessionStorage.setItem(scrollKey, json)
        } catch (e) {
            threw = true
            error = String(e)
        }
        const stored = window.sessionStorage.getItem(scrollKey)
        return {
            threw,
            error,
            requestedRoutes: scrollRoutes,
            storedBytes: stored ? stored.length : 0,
            storedRoutes: stored ? Object.keys(JSON.parse(stored)).length : 0,
        }
    }, { scrollRoutes: args.scrollRoutes, scrollKey: SCROLL_KEY })

    // Prefill sessionStorage toward quota with unrelated keys
    const fillResult = await page.evaluate((fillMb) => {
        const chunk = 'x'.repeat(1024 * 256)
        const targetBytes = fillMb * 1024 * 1024
        let added = 0
        let i = 0
        const errors = []
        while (added < targetBytes) {
            try {
                sessionStorage.setItem(`__hapi_fill_${i}`, chunk)
                added += chunk.length
                i += 1
            } catch (e) {
                errors.push(String(e))
                break
            }
        }
        return { keys: i, approxMb: added / (1024 * 1024), errors }
    }, args.fillMb)

    // Scroll + navigate to trigger TanStack scrollRestorationCache.set writes
    const stressResult = await page.evaluate(async ({ navRounds, sessionId }) => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const scrollables = [
            document.scrollingElement,
            ...document.querySelectorAll('[data-scroll-restoration-id], .overflow-y-auto, [class*="overflow-y"], main'),
        ].filter(Boolean)

        const paths = sessionId
            ? [`/sessions/${sessionId}`, '/sessions', `/sessions/${sessionId}?tab=files`, `/sessions/${sessionId}`]
            : ['/sessions', '/settings', '/sessions']

        let navErrors = []
        for (let round = 0; round < navRounds; round += 1) {
            for (const el of scrollables) {
                if (el instanceof Element) {
                    el.scrollTop = (round + 1) * 500
                    el.scrollLeft = 0
                }
            }
            window.scrollTo(0, (round + 1) * 400)
            await sleep(120)

            const path = paths[round % paths.length]
            try {
                history.pushState({}, '', path)
                window.dispatchEvent(new PopStateEvent('popstate'))
            } catch (e) {
                navErrors.push(String(e))
            }
            await sleep(120)
        }
        await sleep(600)
        return { navErrors, scrollableCount: scrollables.length }
    }, { navRounds: args.navRounds, sessionId: args.sessionId })

    await page.waitForTimeout(1000)

    // Burst scroll-key writes near quota — reproduces #716 unwrap race on upstream #707.
    const burstResult = await page.evaluate(async (scrollKey) => {
        const buildState = (n) => {
            const state = {}
            for (let i = 0; i < n; i += 1) {
                state[`/burst/${i}`] = {
                    window: { scrollX: 0, scrollY: i * 11 },
                    'main:nth-child(1)': { scrollX: 0, scrollY: i * 7 },
                }
            }
            return JSON.stringify(state)
        }
        const caughtErrors = []
        for (let round = 0; round < 40; round += 1) {
            try {
                sessionStorage.setItem(scrollKey, buildState(80 + round))
            } catch (e) {
                caughtErrors.push(String(e))
            }
            await new Promise((r) => setTimeout(r, 5))
        }
        return { caughtErrors: caughtErrors.slice(0, 5), caughtCount: caughtErrors.length }
    }, SCROLL_KEY)

    await page.waitForTimeout(500)

    const quotaErrors = [
        ...consoleMessages.filter((m) => /QuotaExceededError|tsr-scroll-restoration/.test(m.text)),
        ...pageErrors.filter((t) => /QuotaExceededError|tsr-scroll-restoration/.test(t)),
    ]

    const scrollKeyAfter = await page.evaluate((scrollKey) => {
        const v = window.sessionStorage.getItem(scrollKey)
        if (!v) return { bytes: 0, routes: 0 }
        try {
            return { bytes: v.length, routes: Object.keys(JSON.parse(v)).length }
        } catch {
            return { bytes: v.length, routes: -1 }
        }
    }, SCROLL_KEY)

    const errorBoundaryVisible = await page.evaluate(() => {
        const text = document.body.innerText
        return /Something went wrong|error boundary|QuotaExceededError/i.test(text)
    })

    await page.screenshot({ path: outPng, fullPage: true })

    const bodySnippet = await page.locator('body').innerText().catch(() => '')

    const result = {
        ok: quotaErrors.length === 0 && !errorBoundaryVisible,
        url,
        signedIn,
        guardInstalled,
        scrollSeed,
        fillResult,
        stressResult,
        burstResult,
        scrollKeyAfter,
        quotaErrors,
        pageErrors,
        errorBoundaryVisible,
        relevantConsole: consoleMessages.filter((m) =>
            /QuotaExceeded|scroll|error/i.test(m.text)
        ).slice(-40),
        bodySnippet: bodySnippet.slice(0, 800),
        screenshot: outPng,
    }

    writeFileSync(outJson, JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.ok ? 0 : 2
} catch (error) {
    await page.screenshot({ path: outPng, fullPage: true }).catch(() => {})
    const fail = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        url,
        consoleMessages: consoleMessages.slice(-20),
        pageErrors,
        screenshot: outPng,
    }
    writeFileSync(outJson, JSON.stringify(fail, null, 2))
    console.error(JSON.stringify(fail, null, 2))
    process.exitCode = 1
} finally {
    await browser.close()
}
