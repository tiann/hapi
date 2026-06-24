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
 *   HAPI_WEB_DIST_SOUP_MARKERS=extra,markers  (append-only override)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { basename, join, relative } from 'node:path'

const driver = process.argv[2] ?? `${process.env.HOME}/coding/hapi/driver`
const MIN_LEN = parseInt(process.env.HAPI_WEB_DIST_VERIFY_MIN_LEN ?? '8', 10)
const MAX_REPORT = 25
const STRICT = process.env.HAPI_WEB_DIST_VERIFY_STRICT !== '0'
const MIN_MAIN_RATIO = parseFloat(process.env.HAPI_WEB_DIST_MIN_MAIN_RATIO ?? '0.85')
const MIN_PRECACHE_DELTA = parseInt(process.env.HAPI_WEB_DIST_MIN_PRECACHE_DELTA ?? '-5', 10)
const EXTRA_SOUP_MARKERS = (process.env.HAPI_WEB_DIST_SOUP_MARKERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** Upstream-shaped dirs — not soup layers we guard for feat-dist swap. */
const STANDARD_TOP_DIRS = new Set([
    'components',
    'hooks',
    'lib',
    'routes',
    'types',
    'api',
    'dev',
    'chat',
    'realtime',
    'vendor-stubs',
])

/** Core routes present before operator soup layers. */
const BASELINE_ROUTE_PATHS = new Set(['/', '/sessions', '/browse', '/settings', '/share'])

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

function featureTopLevelDirs(webSrc) {
    const dirs = []
    for (const name of readdirSync(webSrc)) {
        const p = join(webSrc, name)
        if (!statSync(p).isDirectory()) continue
        if (STANDARD_TOP_DIRS.has(name) || name.startsWith('.')) continue
        dirs.push(name)
    }
    return dirs
}

function collectDynamicImportBasenames(content) {
    const basenames = new Set()
    for (const m of content.matchAll(/import\s*\(\s*['"]@\/([^'"]+)['"]\s*\)/g)) {
        const modPath = m[1].replace(/\.tsx?$/, '')
        const base = modPath.split('/').pop()
        if (base && /^[A-Z]/.test(base)) basenames.add(base)
    }
    return basenames
}

/**
 * Derive dist integrity markers from merged driver web/src — no hardcoded soup list.
 * Catches #921-class feat-dist swaps that drop lazy chunks / feature namespaces.
 */
function collectSoupMarkersFromSource(webSrc) {
    const markers = new Set()
    const featureDirs = featureTopLevelDirs(webSrc)
    for (const dir of featureDirs) markers.add(dir)

    const routeFiles = walk(webSrc).filter(
        (f) => /router\.tsx$/.test(f) || (/\/routes\/.+\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f)),
    )
    for (const file of routeFiles) {
        const content = readFileSync(file, 'utf8')
        for (const m of content.matchAll(/path:\s*['"](\/[^'"]+)['"]/g)) {
            const routePath = m[1]
            if (BASELINE_ROUTE_PATHS.has(routePath)) continue
            if (routePath.startsWith('/sessions')) continue
            markers.add(routePath)
        }
        for (const base of collectDynamicImportBasenames(content)) markers.add(base)
    }

    for (const file of walk(webSrc).filter((f) => /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f))) {
        const content = readFileSync(file, 'utf8')
        const parts = relative(webSrc, file).split(/[/\\]/)
        const inFeature = parts.some((p) => featureDirs.includes(p))
        if (inFeature) {
            for (const base of collectDynamicImportBasenames(content)) markers.add(base)
        }
    }

    const libRoot = join(webSrc, 'lib')
    if (existsSync(libRoot)) {
        for (const file of walk(libRoot).filter((f) => !/\.test\./.test(f))) {
            const stem = basename(file).replace(/\.(tsx?|jsx?)$/, '')
            if (/scratchlist/i.test(stem)) markers.add('scratchlist')
        }
    }

    for (const file of walk(webSrc).filter(
        (f) => /\.tsx$/.test(f) && !/\.test\./.test(f) && !/[/\\]dev[/\\]/.test(f),
    )) {
        const content = readFileSync(file, 'utf8')
        for (const m of content.matchAll(/data-([a-z][a-z0-9-]{3,})/g)) {
            if (m[1].includes('-')) markers.add(`data-${m[1]}`)
        }
        for (const m of content.matchAll(/className="[^"]*aui-([a-z][a-z0-9-]{3,})/g)) {
            if (m[1].includes('-')) markers.add(`aui-${m[1]}`)
        }
    }

    const eventsDebug = join(webSrc, 'components/settings/EventsDebugControls.tsx')
    if (existsSync(eventsDebug)) {
        const content = readFileSync(eventsDebug, 'utf8')
        if (content.includes('Overseer events')) markers.add('Overseer events')
    }

    for (const extra of EXTRA_SOUP_MARKERS) markers.add(extra)

    return [...markers].sort()
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

function largestMainBundleBytes(distDir) {
    const assets = join(distDir, 'assets')
    if (!existsSync(assets)) return 0
    let max = 0
    for (const name of readdirSync(assets)) {
        if (!/^index-.*\.js$/.test(name)) continue
        const size = statSync(join(assets, name)).size
        if (size > max) max = size
    }
    return max
}

function countPrecacheUrls(distDir) {
    const swPath = join(distDir, 'sw.js')
    if (!existsSync(swPath)) return null
    const sw = readFileSync(swPath, 'utf8')
    return (sw.match(/"url":/g) ?? []).length
}

function distAssetNames(distDir) {
    const assets = join(distDir, 'assets')
    if (!existsSync(assets)) return []
    return readdirSync(assets)
}

function distHasMarker(distDir, distBlob, marker) {
    if (distBlob.includes(marker)) return true
    for (const name of distAssetNames(distDir)) {
        if (name.includes(marker)) return true
    }
    return false
}

function verifySoupIntegrity(distDir, distBlob, soupMarkers) {
    const failures = []
    const prevDir = join(distDir, '..', 'dist.prev')

    for (const marker of soupMarkers) {
        if (!distHasMarker(distDir, distBlob, marker)) {
            failures.push(`soup marker missing from dist (derived from web/src): ${marker}`)
        }
    }

    const mainBytes = largestMainBundleBytes(distDir)
    if (mainBytes > 0 && existsSync(join(prevDir, 'index.html'))) {
        const prevMain = largestMainBundleBytes(prevDir)
        if (prevMain > 0 && mainBytes < prevMain * MIN_MAIN_RATIO) {
            failures.push(
                `main bundle regressed: ${mainBytes} bytes vs dist.prev ${prevMain} (min ratio ${MIN_MAIN_RATIO}) — likely feat-dist swap or partial build`,
            )
        }
        const precache = countPrecacheUrls(distDir)
        const prevPrecache = countPrecacheUrls(prevDir)
        if (precache != null && prevPrecache != null && precache < prevPrecache + MIN_PRECACHE_DELTA) {
            failures.push(
                `precache regressed: ${precache} urls vs dist.prev ${prevPrecache} (min delta ${MIN_PRECACHE_DELTA})`,
            )
        }
    }

    return failures
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
const soupMarkers = collectSoupMarkersFromSource(webSrc)
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

const soupFailures = verifySoupIntegrity(distDir, distBlob, soupMarkers)
if (soupFailures.length > 0) {
    missing.push(...soupFailures)
}

if (missing.length === 0) {
    let metaNote = ''
    if (existsSync(metaPath)) {
        try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
            const head = execSync(`git -C ${JSON.stringify(driver)} rev-parse HEAD`, { encoding: 'utf8' }).trim()
            if (meta.driverHead && meta.driverHead !== head) {
                const msg = `dist meta ${meta.driverHead.slice(0, 8)} != driver HEAD ${head.slice(0, 8)}`
                if (STRICT) {
                    missing.push(msg)
                } else {
                    metaNote = ` (warning: ${msg})`
                }
            }
            if (STRICT && meta.builtBy && meta.builtBy !== 'build_web_atomic') {
                missing.push(`dist builtBy=${meta.builtBy} (expected build_web_atomic — manual dist copy?)`)
            }
        } catch {
            /* ignore meta parse / git */
        }
    } else if (STRICT) {
        console.error('verify-soup-web-dist: note: missing .hapi-build-meta.json (run hapi-driver-build-web to stamp)')
    }
}

if (missing.length === 0) {
    console.log(
        `verify-soup-web-dist: OK (${usedKeys.size} t() key(s), ${soupMarkers.length} soup marker(s) from web/src + integrity checks) in ${relative(driver, distDir)}`,
    )
    process.exit(0)
}

console.error(`verify-soup-web-dist: FAIL — ${missing.length} issue(s):`)
for (const line of missing.slice(0, MAX_REPORT)) {
    console.error(`  - ${line}`)
}
if (missing.length > MAX_REPORT) {
    console.error(`  ... and ${missing.length - MAX_REPORT} more`)
}
console.error('')
console.error('Dist is stale vs merged driver web/src. Fix: hapi-driver-build-web (or hapi-driver-rebuild --build-web).')
console.error('Never cp feat/worktree web/dist into driver — that rolls back soup layers.')
console.error('Emergency rollback: hapi-driver-rollback-web')
process.exit(1)
