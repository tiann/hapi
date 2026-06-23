/**
 * Tooling-only vite config for driver web builds when the full PWA injectManifest
 * pass self-terminates under memory pressure (observed 2026-06-22: SIGTERM ~5s into transform).
 *
 * Usage (from driver/web):
 *   node ../../scripts/tooling/vite.driver-soup-build.mjs
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const driverWeb = resolve(here, '../../driver/web')
const require = createRequire(resolve(driverWeb, 'package.json'))

// Patch: load driver vite config and strip VitePWA plugin for this build.
const { default: driverConfigFn } = await import(`file://${resolve(driverWeb, 'vite.config.ts')}`)
const base = typeof driverConfigFn === 'function' ? driverConfigFn({ mode: 'production', command: 'build' }) : driverConfigFn
const plugins = (base.plugins ?? []).filter((p) => {
    const name = p?.name ?? ''
    return !name.includes('vite-plugin-pwa') && name !== 'vite:pwa'
})

/** @type {import('vite').UserConfig} */
const config = {
    ...base,
    plugins,
    build: {
        ...base.build,
        outDir: process.env.HAPI_WEB_OUTDIR ?? 'dist.next',
        emptyOutDir: true,
    },
}

// When invoked directly, run vite build with this config.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const outDir = process.env.HAPI_WEB_OUTDIR ?? 'dist.next'
    const node = process.execPath
    const viteBin = resolve(driverWeb, 'node_modules/vite/bin/vite.js')
    const env = {
        ...process.env,
        NODE_OPTIONS: process.env.NODE_OPTIONS ?? '--max-old-space-size=6144',
    }
    const r = spawnSync(
        node,
        [viteBin, 'build', '--config', fileURLToPath(import.meta.url), '--outDir', outDir],
        { cwd: driverWeb, env, stdio: 'inherit' },
    )
    process.exit(r.status ?? 1)
}

export default config
