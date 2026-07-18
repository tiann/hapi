import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'

const distDir = join(import.meta.dir, '..', 'dist')
const assetsDir = join(distDir, 'assets')

if (!existsSync(assetsDir)) {
    throw new Error(`Web build assets are missing: ${assetsDir}`)
}

const cssFiles = readdirSync(assetsDir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => join(assetsDir, name))

const referenced = new Set<string>()
for (const cssFile of cssFiles) {
    const css = readFileSync(cssFile, 'utf8')
    for (const match of css.matchAll(/url\(([^)]+)\)/g)) {
        const raw = match[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''
        if (!/katex/i.test(raw) || raw.startsWith('data:')) {
            continue
        }
        const withoutQuery = raw.split(/[?#]/, 1)[0] ?? ''
        const resolved = withoutQuery.startsWith('/')
            ? join(distDir, withoutQuery.slice(1))
            : normalize(join(dirname(cssFile), withoutQuery))
        referenced.add(resolved)
    }
}

if (referenced.size === 0) {
    throw new Error('The Web build contains no external KaTeX font references')
}

const missing = [...referenced].filter((path) => !existsSync(path))
if (missing.length > 0) {
    throw new Error(
        `The Web build is missing ${missing.length} referenced KaTeX font files:\n` +
        missing.map((path) => `- ${path}`).join('\n')
    )
}

if (![...referenced].some((path) => basename(path).endsWith('.woff2'))) {
    throw new Error('The Web build contains no referenced KaTeX WOFF2 font')
}

console.log(`Verified ${referenced.size} KaTeX font assets in ${distDir}`)
