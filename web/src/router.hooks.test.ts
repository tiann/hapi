import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * SessionPage returns early while session data is still loading. A hook
 * declared after that branch only runs once the data resolves, which changes
 * the hook count between renders and makes React throw "Rendered more hooks
 * than during the previous render" — breaking ordinary session opening, not
 * just search deep links (tiann/hapi#1598 review).
 */
describe('SessionPage hook order', () => {
    const source = readFileSync(resolve(__dirname, 'router.tsx'), 'utf8')
    const lines = source.split('\n')

    it('declares every hook before the session loading early return', () => {
        const guardIndex = lines.findIndex((line) => line.trim() === 'if (!session) {')
        expect(guardIndex).toBeGreaterThan(-1)

        // Where SessionPage's body ends: the next top-level function.
        const endIndex = lines.findIndex(
            (line, index) => index > guardIndex && /^(function|const) \w+/.test(line)
        )
        const tail = lines.slice(guardIndex, endIndex === -1 ? undefined : endIndex)

        const offenders = tail
            .map((line, index) => ({ line: line.trim(), at: guardIndex + index + 1 }))
            .filter(({ line }) => /^\s*const .*=\s*use(Callback|Memo|Effect|State|Ref|LayoutEffect)\(/.test(line)
                || /^\s*use(Effect|LayoutEffect)\(/.test(line))

        expect(offenders).toEqual([])
    })
})
