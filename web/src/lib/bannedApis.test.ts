import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Match strings/templates first, so `//` in URLs and API names in comments are
// not code. Blank literal contents too, so a string-only mention cannot fail;
// newlines survive, keeping reported line numbers exact.
const STRIP = /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/.*|\/\*[\s\S]*?\*\//g
const blank = (s: string) => s.replace(/[^\n]/g, ' ')

function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return walk(path)
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|d)\.(ts|tsx)$/.test(entry.name)) return []
        return [path]
    })
}

// Single scan: every source file is read and sanitized once for the whole table.
const FILES = walk(SRC_DIR).map((file) => ({
    path: relative(SRC_DIR, file).replaceAll('\\', '/'),
    code: readFileSync(file, 'utf8').replace(STRIP, (match, literal) => blank(literal ?? match)),
}))

const BANNED = [
    { api: 'crypto.randomUUID', pattern: /\bcrypto\s*\??\.\s*randomUUID\b/, allow: 'lib/randomId.ts', replacement: 'randomId()' },
    { api: 'navigator.clipboard.writeText', pattern: /\bnavigator\s*\??\.\s*clipboard\s*\??\.\s*writeText\b/, allow: 'lib/clipboard.ts', replacement: 'safeCopyToClipboard()' },
] as const

describe('secure-context browser APIs', () => {
    it.each(BANNED)('$api is confined to $allow (use $replacement)', ({ api, pattern, allow, replacement }) => {
        const offenders = FILES.flatMap(({ path, code }) => {
            if (path === allow) return []
            const match = pattern.exec(code)
            if (!match) return []
            const line = code.slice(0, match.index).split('\n').length
            return [`${path}:${line} uses ${api}; replace with ${replacement}`]
        })
        expect(offenders).toEqual([])
    })
})
