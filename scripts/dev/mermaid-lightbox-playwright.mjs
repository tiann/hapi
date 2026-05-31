#!/usr/bin/env node
/**
 * Playwright: one lightbox open + fit assertion per mermaid diagram type.
 *
 * Prereq: Vite dev server serving web (default http://127.0.0.1:5173).
 *   cd web && npm run dev
 *
 * Env:
 *   MERMAID_E2E_BASE_URL  default http://127.0.0.1:5173
 *   PLAYWRIGHT_CHROME_PATH  default /usr/bin/google-chrome
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = resolve(REPO_ROOT, 'web')

const BASE_URL = (process.env.MERMAID_E2E_BASE_URL ?? 'http://127.0.0.1:5173').replace(/\/$/, '')
const START_DEV = process.env.MERMAID_E2E_START_DEV === '1'
const MIN_COVERAGE = Number(process.env.MERMAID_E2E_MIN_COVERAGE ?? '0.35')
const MIN_SVG_PX = Number(process.env.MERMAID_E2E_MIN_SVG_PX ?? '200')

const CASE_IDS = [
    'flowchart',
    'sequence',
    'class',
    'state',
    'er',
    'journey',
    'gantt',
    'pie',
    'quadrant',
    'requirement',
    'gitGraph',
    'c4',
    'mindmap',
    'timeline',
    'kanban',
]

function waitForPort(port, host = '127.0.0.1', timeoutMs = 60_000) {
    const started = Date.now()
    return new Promise((resolve, reject) => {
        const tick = () => {
            const socket = createConnection({ port, host }, () => {
                socket.end()
                resolve(undefined)
            })
            socket.on('error', () => {
                socket.destroy()
                if (Date.now() - started > timeoutMs) {
                    reject(new Error(`Timed out waiting for ${host}:${port}`))
                    return
                }
                setTimeout(tick, 250)
            })
        }
        tick()
    })
}

async function maybeStartDevServer() {
    if (!START_DEV) {
        try {
            await waitForPort(new URL(BASE_URL).port || 5173)
            return null
        } catch {
            console.error(`Dev server not reachable at ${BASE_URL}. Start: cd web && npm run dev`)
            console.error('Or: MERMAID_E2E_START_DEV=1 node scripts/dev/mermaid-lightbox-playwright.mjs')
            process.exit(2)
        }
    }

    const npmBin = process.env.NPM_BIN ?? 'npm'
    const child = spawn(npmBin, ['run', 'dev'], {
        cwd: WEB_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: process.env.PATH, BROWSER: 'none' },
        shell: false,
    })
    child.stdout?.on('data', (chunk) => process.stderr.write(chunk))
    child.stderr?.on('data', (chunk) => process.stderr.write(chunk))
    await waitForPort(new URL(BASE_URL).port || 5173)
    return child
}

async function assertCase(page, caseId) {
    const url = `${BASE_URL}/mermaid-lightbox-e2e.html?case=${encodeURIComponent(caseId)}`
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })

    await page.waitForSelector('[data-mermaid-diagram][data-rendered="true"]', { timeout: 20_000 })
    await page.locator('[data-mermaid-diagram][data-rendered="true"]').click()
    await page.waitForSelector('[role="dialog"]', { timeout: 10_000 })

    await page.waitForFunction(() => {
        const host = document.querySelector('[data-mermaid-lightbox]')
        const svg = host?.shadowRoot?.querySelector('svg')
        if (!svg) return false
        const box = svg.getBoundingClientRect()
        return box.width > 0 && box.height > 0
    }, { timeout: 15_000 })

    await page.waitForFunction(
        (minCoverage) => {
            const host = document.querySelector('[data-mermaid-lightbox]')
            const svg = host?.shadowRoot?.querySelector('svg')
            const box = svg?.getBoundingClientRect()
            if (!box || box.width <= 0) return false
            const vw = window.visualViewport?.width ?? window.innerWidth
            const vh = window.visualViewport?.height ?? window.innerHeight
            const coverage = Math.max(box.width / vw, box.height / vh)
            return coverage >= minCoverage
        },
        MIN_COVERAGE,
        { timeout: 8000 },
    ).catch(() => {
        // Fall through — assertion below reports metrics.
    })

    const metrics = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]')
        const host = dialog?.querySelector('[data-mermaid-lightbox]')
        const svg = host?.shadowRoot?.querySelector('svg')
        const box = svg?.getBoundingClientRect()
        const vw = window.visualViewport?.width ?? window.innerWidth
        const vh = window.visualViewport?.height ?? window.innerHeight
        const shapes = {
            rect: svg?.querySelectorAll('rect').length ?? 0,
            path: svg?.querySelectorAll('path').length ?? 0,
            line: svg?.querySelectorAll('line').length ?? 0,
            text: svg?.querySelectorAll('text').length ?? 0,
            circle: svg?.querySelectorAll('circle').length ?? 0,
        }
        const shapeTotal = shapes.rect + shapes.path + shapes.line + shapes.text + shapes.circle
        return {
            hasShadowSvg: Boolean(svg),
            usesDataUrlImg: Boolean(dialog?.querySelector('img[src^="data:image/svg"]')),
            svgW: box?.width ?? 0,
            svgH: box?.height ?? 0,
            vw,
            vh,
            coverageW: (box?.width ?? 0) / vw,
            coverageH: (box?.height ?? 0) / vh,
            shapes,
            shapeTotal,
        }
    })

    const errors = []
    if (!metrics.hasShadowSvg) errors.push('missing shadow-root svg')
    if (metrics.usesDataUrlImg) errors.push('uses data-url img (regression)')
    if (metrics.svgW < MIN_SVG_PX && metrics.svgH < MIN_SVG_PX) {
        errors.push(`svg too small (${Math.round(metrics.svgW)}x${Math.round(metrics.svgH)}px)`)
    }
    const coverage = Math.max(metrics.coverageW, metrics.coverageH)
    if (coverage < MIN_COVERAGE) {
        errors.push(`does not fill viewport (max axis ${(coverage * 100).toFixed(0)}%)`)
    }
    if (metrics.shapeTotal < 1) errors.push('no svg shapes')

    if (caseId === 'sequence' && metrics.shapes.rect < 2 && metrics.shapes.line < 2) {
        errors.push('sequence diagram looks empty (need multiple actors/lines)')
    }

    return { caseId, ok: errors.length === 0, errors, metrics }
}

async function main() {
    const devChild = await maybeStartDevServer()

    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROME_PATH ?? '/usr/bin/google-chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })

    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
    })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))

    const results = []
    for (const caseId of CASE_IDS) {
        process.stdout.write(`  ${caseId} ... `)
        try {
            const result = await assertCase(page, caseId)
            results.push(result)
            console.log(result.ok ? 'OK' : `FAIL: ${result.errors.join('; ')}`)
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            results.push({ caseId, ok: false, errors: [message], metrics: null })
            console.log(`FAIL: ${message}`)
        }
    }

    await browser.close()
    if (devChild) devChild.kill('SIGTERM')

    const failed = results.filter((r) => !r.ok)
    console.log('\n--- summary ---')
    for (const r of results) {
        const m = r.metrics
        const size = m ? `${Math.round(m.svgW)}x${Math.round(m.svgH)} cov ${(m.coverageW * 100).toFixed(0)}%` : 'n/a'
        console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.caseId}: ${size}${r.errors?.length ? ` — ${r.errors.join('; ')}` : ''}`)
    }
    if (pageErrors.length) {
        console.log('\nPage errors:', pageErrors.slice(0, 5).join('\n'))
    }

    process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
