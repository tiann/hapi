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

// The hazard is the member itself, whatever the receiver: match by member name.
const BY_MEMBER = new Map(BANNED.map((b) => [b.api.slice(b.api.lastIndexOf('.') + 1), b]))

// One parse and one tree pass per file; the file name selects the TS/TSX grammar.
function findOffenders(code: string, fileName = 'inline.ts') {
    const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true)
    const hits: { api: string; line: number }[] = []
    const flag = (name: string, node: ts.Node) => {
        const api = BY_MEMBER.get(name)
        if (api) hits.push({ api: api.api, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 })
    }
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node)) {
            flag(node.name.text, node) // covers optional chaining (`crypto?.randomUUID`)
        } else if (ts.isElementAccessExpression(node)) {
            const arg = node.argumentExpression
            if (arg && ts.isStringLiteralLike(arg)) flag(arg.text, node) // `crypto['randomUUID']()`
        } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && !node.dotDotDotToken) {
            const prop = node.propertyName
            if (prop && (ts.isIdentifier(prop) || ts.isStringLiteralLike(prop))) {
                flag(prop.text, node) // `{ randomUUID: r }`
            } else if (!prop && ts.isIdentifier(node.name)) {
                flag(node.name.text, node) // `{ randomUUID }`
            }
        }
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
    hits: findOffenders(readFileSync(file, 'utf8'), file),
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
        expect(findOffenders('const key = `branch-${crypto.randomUUID()}`', 'case.ts')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('flags an optional-chained call', () =>
        expect(findOffenders('const key = crypto?.randomUUID()', 'case.ts')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('flags a window-prefixed call', () =>
        expect(findOffenders('window.crypto.randomUUID()', 'case.ts')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('flags a globalThis-nested clipboard call', () =>
        expect(findOffenders('globalThis.navigator.clipboard.writeText(x)', 'case.ts')).toEqual([{ api: 'navigator.clipboard.writeText', line: 1 }]))
    it('flags a call on an aliased receiver', () =>
        expect(findOffenders('const c = crypto; c.randomUUID()', 'case.ts')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('flags an element-access call', () =>
        expect(findOffenders("crypto['randomUUID']()", 'case.ts')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('flags a destructured property name', () =>
        expect(findOffenders('const { randomUUID } = crypto', 'case.ts')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('flags a call in a TSX expression', () =>
        expect(findOffenders('const View = () => <span>{crypto.randomUUID()}</span>', 'case.tsx')).toEqual([{ api: 'crypto.randomUUID', line: 1 }]))
    it('ignores TSX text', () =>
        expect(findOffenders('const View = () => <p>crypto.randomUUID()</p>', 'case.tsx')).toEqual([]))
    it('ignores comments, strings and template text', () =>
        expect(findOffenders('// crypto.randomUUID()\nconst s = "navigator.clipboard.writeText"\nconst t = `crypto.randomUUID`', 'case.ts')).toEqual([]))
})
