import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BANNED = [
    { api: 'crypto.randomUUID', allow: 'lib/randomId.ts', replacement: 'randomId()' },
    { api: 'navigator.clipboard.writeText', allow: 'lib/clipboard.ts', replacement: 'safeCopyToClipboard()' },
] as const

// Dotted name of an access chain (covers optional chaining, e.g. `crypto?.randomUUID`).
const dotted = (node: ts.Expression): string | undefined => {
    if (ts.isIdentifier(node)) return node.text
    if (!ts.isPropertyAccessExpression(node)) return undefined
    const base = dotted(node.expression)
    return base && `${base}.${node.name.text}`
}

// One parse and one tree pass per string; comments and literal text are never nodes.
function findOffenders(code: string) {
    const sf = ts.createSourceFile('inline.ts', code, ts.ScriptTarget.Latest, true)
    const hits: { api: string; line: number }[] = []
    const visit = (node: ts.Node): void => {
        const api = ts.isPropertyAccessExpression(node) && BANNED.find((b) => b.api === dotted(node))
        if (api) hits.push({ api: api.api, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
        ts.forEachChild(node, visit)
    }
    visit(sf)
    return hits
}
function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return walk(path)
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.(test|d)\.(ts|tsx)$/.test(entry.name)) return []
        return [path]
    })
}
const FILES = walk(SRC_DIR).map((file) => ({
    path: relative(SRC_DIR, file).replaceAll('\\', '/'),
    hits: findOffenders(readFileSync(file, 'utf8')),
}))

describe('secure-context browser APIs', () => {
    it.each(BANNED)('$api is confined to $allow (use $replacement)', ({ api, allow, replacement }) => {
        const bad = FILES.filter((f) => f.path !== allow).flatMap((f) =>
            f.hits.filter((h) => h.api === api).map((h) => `${f.path}:${h.line} uses ${api}; replace with ${replacement}`))
        expect(bad).toEqual([])
    })
})
describe('matcher self-checks', () => {
    it('flags a call inside a template interpolation', () =>
        expect(findOffenders('const key = `branch-${crypto.randomUUID()}`')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('flags an optional-chained call', () =>
        expect(findOffenders('const key = crypto?.randomUUID()')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('ignores comments, strings and template text', () =>
        expect(findOffenders('// crypto.randomUUID()\nconst s = "navigator.clipboard.writeText"\nconst t = `crypto.randomUUID`')).toEqual([]))
})
