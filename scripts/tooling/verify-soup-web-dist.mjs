#!/usr/bin/env bun
/**
 * Post-build guard: merged driver web/src must be reflected in web/dist.
 *
 * For each t() key used in web/src, dist must contain either the i18n key
 * (survives minification) or the literal locale value (non-template strings).
 * Template strings ({var}) require the key or a static fragment >= MIN_LEN chars.
 *
 * Usage:
 *   bun scripts/tooling/verify-soup-web-dist.mjs [DRIVER]
 *
 * Env:
 *   HAPI_WEB_DIST_VERIFY_MIN_LEN=8
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, relative } from 'node:path'

const driver = process.argv[2] ?? `${process.env.HOME}/coding/hapi/driver`
const MIN_LEN = parseInt(process.env.HAPI_WEB_DIST_VERIFY_MIN_LEN ?? '8', 10)
const MAX_REPORT = 25

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        const st = statSync(p)
        if (st.isDirectory()) {
            if (name === 'node_modules' || name === 'dist' || name === 'dist.prev' || name === 'dist.next') continue
            walk(p, out)
        } else {
            out.push(p)
        }
    }
    return out
}

function parseEnLocale(enPath) {
    const text = readFileSync(enPath, 'utf8')
    const map = new Map()
    const sqValue = String.raw`'(?:\\'|\\u[0-9a-fA-F]{4}|[^'\\])*'`
    const dqValue = String.raw`"(?:\\"|\\u[0-9a-fA-F]{4}|[^"\\])*"`
    const re = new RegExp(String.raw`'([^']+)':\s*(${sqValue}|${dqValue})`, 'g')
    for (const m of text.matchAll(re)) {
        const raw = m[2]
        const unquoted = raw.slice(1, -1)
        const value = unquoted
            .replace(/\\'/g, "'")
            .replace(/\\"/g, '"')
            .replace(/\\u2014/g, '\u2014')
        map.set(m[1], value)
    }
    return map
}

function collectUsedKeys(srcRoot) {
    const keys = new Set()
    for (const file of walk(srcRoot).filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f))) {
        const content = readFileSync(file, 'utf8')
        for (const m of content.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
            keys.add(m[1])
        }
    }
    return keys
}

function readDistBlob(distDir) {
    const assets = join(distDir, 'assets')
    if (!existsSync(assets)) throw new Error(`dist assets missing: ${assets}`)
    let blob = ''
    for (const name of readdirSync(assets)) {
        if (!name.endsWith('.js')) continue
        blob += readFileSync(join(assets, name), 'utf8')
    }
    if (!blob) throw new Error('no JS assets in dist')
    return blob
}

function blobHas(distBlob, needle) {
    if (distBlob.includes(needle)) return true
    if (needle.includes('\u2014') && distBlob.includes(needle.replace('\u2014', '\\u2014'))) return true
    return false
}

function staticFragments(value) {
    return value
        .split(/\{[^}]+\}/)
        .map((s) => s.trim())
        .filter((s) => s.length >= MIN_LEN && /[A-Za-z]/.test(s))
}

function keySatisfied(distBlob, key, value) {
    if (blobHas(distBlob, key)) return true

    if (!value.includes('{') && value.length >= MIN_LEN && blobHas(distBlob, value)) {
        return true
    }

    if (value.includes('{')) {
        const frags = staticFragments(value)
        if (frags.some((f) => blobHas(distBlob, f))) return true
    }

    // Citation template (copy-reference) — minifier may split across chunks
    if (key === 'session.action.copyReference') {
        return blobHas(distBlob, 'copyReference') || (blobHas(distBlob, 'See session') && blobHas(distBlob, 'for context'))
    }

    return false
}

const webSrc = join(driver, 'web/src')
const enPath = join(webSrc, 'lib/locales/en.ts')
const distDir = join(driver, 'web/dist')
const metaPath = join(distDir, '.hapi-build-meta.json')

if (!existsSync(enPath)) {
    console.error(`verify-soup-web-dist: missing ${enPath}`)
    process.exit(1)
}
if (!existsSync(join(distDir, 'index.html'))) {
    console.error(`verify-soup-web-dist: missing ${distDir}/index.html (run --build-web first)`)
    process.exit(1)
}

const locale = parseEnLocale(enPath)
const usedKeys = collectUsedKeys(webSrc)
const distBlob = readDistBlob(distDir)

const missing = []
for (const key of usedKeys) {
    const value = locale.get(key)
    if (!value) {
        missing.push(`${key} (missing from en.ts)`)
        continue
    }
    if (!keySatisfied(distBlob, key, value)) {
        missing.push(`${key} → ${JSON.stringify(value.slice(0, 80))}${value.length > 80 ? '…' : ''}`)
    }
}

if (missing.length === 0) {
    let metaNote = ''
    if (existsSync(metaPath)) {
        try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
            const head = execSync(`git -C ${JSON.stringify(driver)} rev-parse HEAD`, { encoding: 'utf8' }).trim()
            if (meta.driverHead && meta.driverHead !== head) {
                metaNote = ` (warning: dist meta ${meta.driverHead.slice(0, 8)} != driver HEAD ${head.slice(0, 8)})`
            }
        } catch {
            /* ignore meta parse / git */
        }
    }
    console.log(
        `verify-soup-web-dist: OK (${usedKeys.size} t() key(s) satisfied in ${relative(driver, distDir)})${metaNote}`,
    )
    process.exit(0)
}

console.error(`verify-soup-web-dist: FAIL — ${missing.length} t() key(s) missing from web/dist:`)
for (const line of missing.slice(0, MAX_REPORT)) {
    console.error(`  - ${line}`)
}
if (missing.length > MAX_REPORT) {
    console.error(`  ... and ${missing.length - MAX_REPORT} more`)
}
console.error('')
console.error('Dist is stale vs merged driver web/src. Fix: hapi-driver-build-web (or hapi-driver-rebuild --build-web).')
console.error('Emergency rollback: hapi-driver-rollback-web')
process.exit(1)
