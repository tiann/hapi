import { describe, expect, it } from 'vitest'
import { getToolPresentation } from '@/components/ToolCard/knownTools'

describe('getToolPresentation — unknown tool semantic title + subtitle dedup', () => {
    it('promotes semantic title "Run shell" when toolName equals input.command (Gemini ACP case)', () => {
        const presentation = getToolPresentation({
            toolName: 'cat /tmp/hello.txt',
            input: { command: 'cat /tmp/hello.txt' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Run shell')
        expect(presentation.subtitle).toBe('cat /tmp/hello.txt')
    })

    it('promotes semantic title "Read file" when toolName equals input.file_path', () => {
        const presentation = getToolPresentation({
            toolName: 'README.md',
            input: { file_path: 'README.md' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Read file')
        expect(presentation.subtitle).toBe('README.md')
    })

    it('promotes semantic title "Search" when toolName equals input.pattern', () => {
        const presentation = getToolPresentation({
            toolName: '*.ts',
            input: { pattern: '*.ts' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('Search')
        expect(presentation.subtitle).toBe('*.ts')
    })

    it('keeps the original toolName when subtitle differs (no promotion needed)', () => {
        const presentation = getToolPresentation({
            toolName: 'run_shell_command',
            input: { command: 'ls -la /tmp' },
            result: null,
            childrenCount: 0,
            description: null,
            metadata: null,
        })

        expect(presentation.title).toBe('run_shell_command')
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

        expect(presentation.title).toBe('mystery_tool')
        expect(presentation.subtitle).toBeNull()
    })
})
