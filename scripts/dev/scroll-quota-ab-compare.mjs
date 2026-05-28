#!/usr/bin/env node
/**
 * A/B compare scroll quota stress: fixed vs upstream-main (broken #707 unwrap).
 *
 * Usage:
 *   node scripts/dev/scroll-quota-ab-compare.mjs --session <id>
 *
 * Env:
 *   HAPI_ACCESS_TOKEN — CLI token for auth
 *   HAPI_URL_FIXED — default http://127.0.0.1:3006 (PR #717 worktree)
 *   HAPI_URL_BROKEN — default http://127.0.0.1:3007 (upstream/main hub)
 */
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync, mkdirSync } from 'node:fs'

const __dir = dirname(fileURLToPath(import.meta.url))
const repro = resolve(__dir, 'scroll-quota-repro-playwright.mjs')

function parseArgs(argv) {
    const args = { sessionId: '', fillMb: 4.5, scrollRoutes: 250, navRounds: 12 }
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i]
        if (arg === '--session') args.sessionId = argv[++i]
        else if (arg === '--fill-mb') args.fillMb = Number(argv[++i])
        else if (arg === '--scroll-routes') args.scrollRoutes = Number(argv[++i])
        else if (arg === '--nav-rounds') args.navRounds = Number(argv[++i])
    }
    return args
}

const args = parseArgs(process.argv.slice(2))
const token = process.env.HAPI_ACCESS_TOKEN ?? ''
const fixedUrl = process.env.HAPI_URL_FIXED ?? 'http://127.0.0.1:3006'
const brokenUrl = process.env.HAPI_URL_BROKEN ?? 'http://127.0.0.1:3007'

function runVariant(label, baseUrl) {
    const env = {
        ...process.env,
        HAPI_URL: baseUrl,
        HAPI_ACCESS_TOKEN: token,
    }
    const proc = spawnSync(
        process.execPath,
        [
            repro,
            '--session', args.sessionId,
            '--fill-mb', String(args.fillMb),
            '--scroll-routes', String(args.scrollRoutes),
            '--nav-rounds', String(args.navRounds),
        ],
        { env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    )
    let parsed = null
    try {
        const jsonStart = proc.stdout.lastIndexOf('{')
        parsed = JSON.parse(proc.stdout.slice(jsonStart))
    } catch {
        parsed = { ok: false, parseError: true, stdout: proc.stdout.slice(-2000), stderr: proc.stderr }
    }
    return { label, baseUrl, exitCode: proc.status ?? 1, result: parsed }
}

if (!args.sessionId) {
    console.error('Usage: scroll-quota-ab-compare.mjs --session <id>')
    process.exit(2)
}

console.log('Running A/B scroll quota stress...')
console.log(`  FIXED  → ${fixedUrl}`)
console.log(`  BROKEN → ${brokenUrl}`)
console.log('')

const broken = runVariant('upstream-main (#707 unwrap)', brokenUrl)
const fixed = runVariant('PR #717 (patched cache.set)', fixedUrl)

const summary = {
    sessionId: args.sessionId,
    params: args,
    broken,
    fixed,
    regressionDetected: Boolean(broken.result?.ok === false && (broken.result?.quotaErrors?.length || broken.result?.pageErrors?.length)),
    fixVerified: Boolean(fixed.result?.ok === true && !(fixed.result?.quotaErrors?.length)),
}

mkdirSync(resolve('localdocs/playwright-runs'), { recursive: true })
const out = resolve('localdocs/playwright-runs', `scroll-quota-ab-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(summary, null, 2))

console.log(JSON.stringify({
    broken: {
        ok: broken.result?.ok,
        quotaErrors: broken.result?.quotaErrors,
        pageErrors: broken.result?.pageErrors,
        scrollKeyAfter: broken.result?.scrollKeyAfter,
        exitCode: broken.exitCode,
    },
    fixed: {
        ok: fixed.result?.ok,
        quotaErrors: fixed.result?.quotaErrors,
        pageErrors: fixed.result?.pageErrors,
        scrollKeyAfter: fixed.result?.scrollKeyAfter,
        exitCode: fixed.exitCode,
    },
    regressionDetected: summary.regressionDetected,
    fixVerified: summary.fixVerified,
    report: out,
}, null, 2))

if (!summary.regressionDetected) {
    console.error('\nNOTE: upstream-main did NOT fail this harness — may need harsher race trigger or pre-#707 tree.')
    process.exitCode = 3
} else if (!summary.fixVerified) {
    process.exitCode = 2
} else {
    process.exitCode = 0
}
