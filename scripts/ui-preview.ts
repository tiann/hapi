#!/usr/bin/env bun
import { chromium } from 'playwright'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

const VIEWPORTS = {
    mobile: { width: 390, height: 844 },
    desktop: { width: 1280, height: 800 },
} as const

const DEFAULTS = {
    hub: 'http://127.0.0.1:3006',
    output: '/tmp/hapi-ui-preview.png',
    timeout: 10_000,
    viewport: 'desktop' as keyof typeof VIEWPORTS,
    route: '/sessions',
}

function printHelp(): void {
    console.log(`Usage: bun scripts/ui-preview.ts [options] [route]

Take a screenshot of the HAPI web UI via Playwright.

Arguments:
  route                  Path to capture (default: ${DEFAULTS.route})

Options:
  --viewport <preset>    mobile (390x844) | desktop (1280x800, default)
  --theme <mode>         light | dark (default: light)
  --wait-for <selector>  Wait for CSS selector before capture
  --output <path>        Output path (default: ${DEFAULTS.output})
  --timeout <ms>         Max wait time (default: ${DEFAULTS.timeout})
  --full-page            Capture full scrollable page
  --hub <url>            Hub URL (default: ${DEFAULTS.hub})
  --steps <json>         Interaction steps to run before capture (JSON array)
  --help                 Show this help

Steps JSON format (array of actions executed in order):
  {"click": "<selector>"}     Click an element
  {"wait": "<selector>"}      Wait for element to appear
  {"wait": 500}               Wait N milliseconds
  {"type": "text"}            Type into the focused element
  {"hover": "<selector>"}     Hover over an element
  {"scroll": "<selector>"}    Scroll element into view

Example:
  --steps '[{"click":"text=Refactor auth"},{"wait":".chat-message"}]'`)
}

type Step =
    | { click: string }
    | { wait: string | number }
    | { type: string }
    | { hover: string }
    | { scroll: string }

type Options = {
    route: string
    viewport: keyof typeof VIEWPORTS
    theme: 'light' | 'dark'
    waitFor: string | null
    output: string
    timeout: number
    fullPage: boolean
    hub: string
    steps: Step[]
    help: boolean
}

function parseArgs(): Options {
    const args = process.argv.slice(2)
    const opts: Options = {
        route: DEFAULTS.route,
        viewport: DEFAULTS.viewport,
        theme: 'light',
        waitFor: null,
        output: DEFAULTS.output,
        timeout: DEFAULTS.timeout,
        fullPage: false,
        hub: DEFAULTS.hub,
        steps: [],
        help: false,
    }

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        switch (arg) {
            case '--help': case '-h':
                opts.help = true; break
            case '--viewport':
                opts.viewport = args[++i] as keyof typeof VIEWPORTS; break
            case '--theme':
                opts.theme = args[++i] as 'light' | 'dark'; break
            case '--wait-for':
                opts.waitFor = args[++i]; break
            case '--output': case '-o':
                opts.output = args[++i]; break
            case '--timeout':
                opts.timeout = parseInt(args[++i], 10); break
            case '--full-page':
                opts.fullPage = true; break
            case '--hub':
                opts.hub = args[++i]; break
            case '--steps':
                opts.steps = JSON.parse(args[++i]); break
            default:
                if (!arg.startsWith('-')) {
                    opts.route = arg.startsWith('/') ? arg : `/${arg}`
                }
        }
    }
    return opts
}

function getCliApiToken(): string {
    const hapiHome = process.env.HAPI_HOME || join(homedir(), '.hapi')
    const settingsPath = join(hapiHome, 'settings.json')

    if (!existsSync(settingsPath)) {
        throw new Error(`Settings file not found: ${settingsPath}\nStart the hub first: bun run rebuild`)
    }

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const token = settings.cliApiToken
    if (!token) {
        throw new Error('No cliApiToken in settings.json. Start the hub first: bun run rebuild')
    }
    return token
}

async function checkHub(baseUrl: string): Promise<void> {
    try {
        const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
        if (!resp.ok) throw new Error(`Health check returned ${resp.status}`)
    } catch (error) {
        throw new Error(
            `Hub is not running at ${baseUrl}. Start it with: bun run rebuild\n` +
            `(${error instanceof Error ? error.message : error})`
        )
    }
}

async function main(): Promise<void> {
    const opts = parseArgs()

    if (opts.help) {
        printHelp()
        process.exit(0)
    }

    await checkHub(opts.hub)
    const token = getCliApiToken()

    const url = new URL(opts.route, opts.hub)
    url.searchParams.set('token', token)

    const { width, height } = VIEWPORTS[opts.viewport] ?? VIEWPORTS.desktop

    const outDir = dirname(opts.output)
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: opts.theme,
        deviceScaleFactor: 2,
    })
    const page = await context.newPage()

    try {
        await page.goto(url.toString(), {
            waitUntil: 'load',
            timeout: opts.timeout,
        })

        // Wait for the React app to hydrate — #root will have child content
        await page.waitForFunction(
            () => (document.getElementById('root')?.children.length ?? 0) > 0,
            { timeout: opts.timeout }
        )

        if (opts.waitFor) {
            await page.waitForSelector(opts.waitFor, { timeout: opts.timeout })
        }

        // Run interaction steps
        for (const step of opts.steps) {
            if ('click' in step) {
                await page.click(step.click, { timeout: opts.timeout })
            } else if ('wait' in step) {
                if (typeof step.wait === 'number') {
                    await page.waitForTimeout(step.wait)
                } else {
                    await page.waitForSelector(step.wait, { timeout: opts.timeout })
                }
            } else if ('type' in step) {
                await page.keyboard.type(step.type)
            } else if ('hover' in step) {
                await page.hover(step.hover, { timeout: opts.timeout })
            } else if ('scroll' in step) {
                await page.locator(step.scroll).scrollIntoViewIfNeeded({ timeout: opts.timeout })
            }
        }

        // Allow CSS transitions/animations to settle
        await page.waitForTimeout(1000)

        await page.screenshot({
            path: opts.output,
            fullPage: opts.fullPage,
            type: 'png',
        })

        console.log(`Screenshot saved: ${opts.output}`)
    } finally {
        await browser.close()
    }

    process.exit(0)
}

main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
})
