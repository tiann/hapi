import { describe, expect, it } from 'vitest'
import { buildCliOutput, buildCompressedCliOutput } from './CliOutputBlock'

describe('CliOutputBlock output formatting', () => {
    it('formats tagged CLI output into labeled sections', () => {
        const formatted = buildCliOutput([
            '<command-name>pnpm test</command-name>',
            '<local-command-stdout>PASS\nAll good</local-command-stdout>'
        ].join('\n'))

        expect(formatted).toContain('terminal.commandName:\npnpm test')
        expect(formatted).toContain('terminal.stdout:\nPASS\nAll good')
    })

    it('compresses long UI output while preserving the full head and tail context', () => {
        const longOutput = `stdout:\n${'a'.repeat(80)}\n${'b'.repeat(80)}\n${'c'.repeat(80)}`
        const compressed = buildCompressedCliOutput(longOutput, {
            maxChars: 120,
            edgeChars: 40
        })

        expect(compressed.text.length).toBeLessThan(longOutput.length)
        expect(compressed.text).toContain(`stdout:\n${'a'.repeat(32)}`)
        expect(compressed.text).toContain('c'.repeat(40))
        expect(compressed.text).toContain('chars hidden in UI preview')
        expect(compressed.wasCompressed).toBe(true)
        expect(compressed.originalChars).toBe(longOutput.length)
    })

    it('does not compress short UI output', () => {
        const compressed = buildCompressedCliOutput('short output', {
            maxChars: 120,
            edgeChars: 40
        })

        expect(compressed).toEqual({
            text: 'short output',
            wasCompressed: false,
            originalChars: 'short output'.length,
            displayedChars: 'short output'.length,
            hiddenChars: 0
        })
    })
})
