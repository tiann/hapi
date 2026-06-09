/*
 * Shared E2E test harness for HAPI.
 *
 * Helpers in this file were extracted from the TC-WEB-XX test cases
 * run on 2026-06-09 (`.xyz-harness/2026-06-09-full-e2e-retest/`).
 * They encode the four non-obvious interactions we discovered the
 * hard way:
 *
 *   1. `longPress` — SessionActionMenu is opened by a 500ms press,
 *      not a click. Clicking the card opens the session instead.
 *   2. `mockOffline` — CDP `Network.emulateNetworkConditions` does
 *      not trigger the React app's `useOnlineStatus` hook. We must
 *      override `navigator.onLine` and dispatch the window event.
 *   3. `pollForText` — Thinking/reasoning labels flicker in/out
 *      within <1s; a single evaluate misses them. 0.3s polling for
 *      ~3s captures them reliably.
 *   4. `isVisible` — `element.offsetParent` returns null for
 *      `position: fixed` dialogs (Correct), even when they are
 *      rendered and shown. Use `getBoundingClientRect()` instead.
 *
 * The harness is intentionally framework-light: it wraps
 * `@playwright/test`'s `Page` and the existing
 * `~/.pi/agent/skills/browser-automation/scripts/pw.js` CLI. It does
 * not start its own browser; it expects Chrome to be running with
 * `--remote-debugging-port=9222` (see `startChrome` below).
 *
 * Usage in a spec:
 *
 *   import { test, expect } from '@playwright/test'
 *   import {
 *       startChrome, stopChrome,
 *       longPress, mockOffline, pollForText, isVisible,
 *       loginWithToken, listSessions,
 *   } from './harness'
 *
 *   test.beforeAll(async () => {
 *       await startChrome()
 *   })
 *   test.afterAll(async () => {
 *       await stopChrome()
 *   })
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

const EP = 'http://localhost:9222'
// The browser-automation skill may live under either ~/.pi/agent/skills
// (Pi auto-discovery) or ~/.agents/skills (Claude Code discovery).
// Both directories are symlinked, but on some setups only one resolves.
const HOME = homedir()
function resolveSkillScript(name: string): string {
    const candidates = [
        join(HOME, '.pi/agent/skills/browser-automation/scripts', name),
        join(HOME, '.agents/skills/browser-automation/scripts', name),
    ]
    for (const c of candidates) {
        if (existsSync(c)) return c
    }
    throw new Error(
        `browser-automation script not found: ${name}. ` +
        `Tried: ${candidates.join(', ')}`
    )
}
const PW_SCRIPT = resolveSkillScript('pw.js')
const CDP_SCRIPT = resolveSkillScript('cdp.js')
const CHROME_BIN = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

export const ENV = {
    EP,
    PW_SCRIPT,
    CDP_SCRIPT,
    CHROME_BIN,
    WEB_URL: process.env.HAPI_WEB_URL ?? 'http://localhost:5173',
    HUB_URL: process.env.HAPI_HUB_URL ?? 'http://localhost:3006',
} as const

// =============================================================================
// Chrome lifecycle
// =============================================================================

let chromeProcess: ChildProcess | null = null
let chromeProfileDir: string | null = null

/**
 * Start a headless Chrome with a clean profile and remote debugging on
 * port 9222. Safe to call multiple times; subsequent calls are no-ops
 * if Chrome is already listening on 9222.
 */
export async function startChrome(): Promise<void> {
    if (isChromeRunning()) return
    chromeProfileDir = join(tmpdir(), `hapi-e2e-chrome-${Date.now()}`)
    mkdirSync(chromeProfileDir, { recursive: true })
    chromeProcess = spawn(
        ENV.CHROME_BIN,
        [
            '--headless=new',
            '--remote-debugging-port=9222',
            '--remote-debugging-address=127.0.0.1',
            `--user-data-dir=${chromeProfileDir}`,
            '--disable-gpu',
            '--no-first-run',
            '--window-size=1280,800',
        ],
        { stdio: 'ignore', detached: false }
    )
    // Wait up to 5s for the port to open
    for (let i = 0; i < 50; i++) {
        if (isChromeRunning()) return
        await sleep(100)
    }
    throw new Error('Chrome failed to start on 9222 within 5s')
}

/**
 * Stop the Chrome process started by `startChrome`. Does not touch
 * any other Chrome instance (per the browser-automation skill rule:
 * never `pkill chrome`).
 */
export async function stopChrome(): Promise<void> {
    if (!chromeProcess) return
    const pid = chromeProcess.pid
    if (pid) {
        try {
            execSync(`kill ${pid}`, { stdio: 'ignore' })
        } catch {
            // already gone
        }
    }
    chromeProcess = null
    if (chromeProfileDir && existsSync(chromeProfileDir)) {
        rmSync(chromeProfileDir, { recursive: true, force: true })
        chromeProfileDir = null
    }
}

function isChromeRunning(): boolean {
    try {
        const out = execSync(`lsof -ti :9222`, { encoding: 'utf8' }).trim()
        return out.length > 0
    } catch {
        return false
    }
}

// =============================================================================
// pw.js wrapper
// =============================================================================

type PwResult<T = unknown> = { value?: T; error?: string; [k: string]: unknown }

function pw(cmd: string): PwResult {
    try {
        const out = execSync(`node ${ENV.PW_SCRIPT} ${ENV.EP} ${cmd}`, {
            encoding: 'utf8',
            timeout: 30_000,
        })
        try {
            return JSON.parse(out) as PwResult
        } catch {
            return { value: out as unknown }
        }
    } catch (e) {
        return { error: (e as Error).message }
    }
}

// =============================================================================
// Page-level helpers (run in the browser context via the pw.js CLI)
// =============================================================================

/**
 * Run a JavaScript expression in the page and return the resolved
 * value. Wraps the expression for safe shell-quoting.
 */
export function evalInPage<T = unknown>(expr: string): T {
    const escaped = expr.replace(/"/g, '\\"').replace(/\$/g, '\\$')
    const result = pw(`evaluate "${escaped}"`)
    if (result.error) throw new Error(`evalInPage failed: ${result.error}`)
    return (result.value ?? result) as T
}

/**
 * Long-press an element located by a CSS selector. Simulates a
 * 500ms+ mousedown (no mouseup), which is what
 * `useLongPress({ threshold: 500 })` in SessionList.tsx listens for.
 * Required for triggering the SessionActionMenu.
 */
export async function longPress(selector: string, page?: Page): Promise<void> {
    if (page) {
        // Preferred path: use Playwright directly
        const el = await page.locator(selector).first()
        const box = await el.boundingBox()
        if (!box) throw new Error(`longPress: element not found: ${selector}`)
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
        await page.mouse.down()
        await sleep(600)
        await page.mouse.up()
    } else {
        // Fallback path: dispatch via pw.js + evaluate
        evalInPage(`
            (() => {
                const target = document.querySelector(${JSON.stringify(selector)});
                if (!target) return { error: 'not found' };
                const r = target.getBoundingClientRect();
                target.dispatchEvent(new MouseEvent('mousedown', {
                    bubbles: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, button: 0
                }));
                return { ok: true };
            })()
        `)
        await sleep(600)
    }
}

/**
 * Simulate the browser going offline by overriding `navigator.onLine`
 * and dispatching the window `offline` event. This is what
 * `useOnlineStatus` actually listens for — CDP's
 * `Network.emulateNetworkConditions` does NOT trigger the hook.
 */
export async function mockOffline(online: boolean): Promise<void> {
    evalInPage(`
        (() => {
            Object.defineProperty(navigator, 'onLine', { value: ${online}, configurable: true });
            window.dispatchEvent(new Event(${online ? "'online'" : "'offline'"}));
            return { online: navigator.onLine };
        })()
    `)
}

/**
 * Poll `document.body.innerText` every `intervalMs` for at most
 * `timeoutMs`, calling `match(text)` until it returns true. Returns
 * the matched text or null. Use this to catch transient UI states
 * like thinking/reasoning indicators that flicker for <1s.
 */
export async function pollForText(
    match: (text: string) => boolean,
    options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<string | null> {
    const timeoutMs = options.timeoutMs ?? 3000
    const intervalMs = options.intervalMs ?? 300
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const text = evalInPage<string>('document.body.innerText')
        if (text && match(text)) return text
        await sleep(intervalMs)
    }
    return null
}

/**
 * Check whether an element is actually visible in the viewport.
 * Uses `getBoundingClientRect()` because `offsetParent` returns
 * null for `position: fixed` elements (e.g. modal dialogs) even
 * when they are rendered and visible.
 */
export function isVisible(selector: string): boolean {
    return evalInPage<boolean>(`
        (() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        })()
    `)
}

/**
 * Click an element matched by a Playwright text/role/label selector
 * and wait for `waitFor` to become truthy (default: any visible
 * change in the page). Retries up to 3 times on click timeouts
 * (a common flake source for elements that re-render).
 */
export async function clickAndWait(
    page: Page,
    selector: string,
    options: { waitMs?: number; retries?: number } = {}
): Promise<void> {
    const retries = options.retries ?? 3
    for (let i = 0; i < retries; i++) {
        try {
            await page.locator(selector).first().click({ timeout: 5_000 })
            await sleep(options.waitMs ?? 500)
            return
        } catch (e) {
            if (i === retries - 1) throw e
            await sleep(500)
        }
    }
}

// =============================================================================
// Hub API helpers
// =============================================================================

export type SessionSummary = {
    id: string
    active: boolean
    archived?: boolean
    metadata?: { flavor?: 'pi' | 'claude' | 'codex'; path?: string; name?: string }
}

/**
 * Authenticate against the hub: exchange the CLI access token for a
 * short-lived JWT that the web REST API requires. The web frontend
 * does this automatically, but server-side tests need to do it
 * explicitly.
 */
export async function loginWithToken(accessToken: string): Promise<string> {
    const res = await fetch(`${ENV.HUB_URL}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken }),
    })
    if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { token: string }
    return data.token
}

export async function listSessions(jwt: string): Promise<SessionSummary[]> {
    const res = await fetch(`${ENV.HUB_URL}/api/sessions`, {
        headers: { Authorization: `Bearer ${jwt}` },
    })
    if (!res.ok) throw new Error(`listSessions failed: ${res.status}`)
    const data = (await res.json()) as { sessions: SessionSummary[] }
    return data.sessions
}

// =============================================================================
// Misc
// =============================================================================

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
