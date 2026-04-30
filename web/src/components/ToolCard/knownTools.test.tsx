import { describe, expect, it } from 'vitest'
import { getToolPresentation } from '@/components/ToolCard/knownTools'

describe('getToolPresentation — unknown tool subtitle dedup', () => {
    it('omits subtitle when input.command equals toolName (Gemini ACP title-as-command case)', () => {
        const presentation = getToolPresentation({
            toolName: 'cat /tmp/hello.txt',
            input: { command: 'cat /tmp/hello.txt' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('cat /tmp/hello.txt')
        expect(presentation.subtitle).toBeNull()
    })

    it('omits subtitle when input.file_path equals toolName', () => {
        const presentation = getToolPresentation({
            toolName: 'README.md',
            input: { file_path: 'README.md' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.subtitle).toBeNull()
    })

    it('keeps subtitle when it differs from toolName', () => {
        const presentation = getToolPresentation({
            toolName: 'run_shell_command',
            input: { command: 'ls -la /tmp' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.subtitle).toBe('ls -la /tmp')
    })

    it('returns null subtitle when no recognized input field is present', () => {
        const presentation = getToolPresentation({
            toolName: 'mystery_tool',
            input: { foo: 'bar' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.subtitle).toBeNull()
    })
})
