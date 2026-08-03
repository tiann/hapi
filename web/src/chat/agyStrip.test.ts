import { describe, it, expect } from 'vitest'
import { stripAgyActionPreamble, parseAgyAsyncTaskMessage, stripAgyEchoedTaskResult, stripAgyReadArtifacts } from './normalizeAgent'

describe('stripAgyReadArtifacts', () => {
    it('drops the full-read trailer, keeping the per-line numbers (the renderer offsets the gutter)', () => {
        const raw = [
            '50: image_width: 1080',
            '51: image_height: 2280',
            'The above content shows the entire, complete file contents of the requested file.',
        ].join('\n')
        // The "<n>: " prefixes stay so a partial read keeps its true line numbers.
        expect(stripAgyReadArtifacts(raw)).toBe('50: image_width: 1080\n51: image_height: 2280')
    })

    it('drops the partial-read trailer too ("does NOT show the entire file contents…")', () => {
        const raw = '50:\n51: ---\nThe above content does NOT show the entire file contents. If you need to view any lines …'
        expect(stripAgyReadArtifacts(raw)).toBe('50:\n51: ---')
    })
})

describe('stripAgyEchoedTaskResult', () => {
    it('keeps the agent narration but drops the echoed raw task-result block', () => {
        const raw = 'Inside the task-246 log...\n[Message] timestamp=2026-07-08T06:04:31Z sender=u/task-246 content=Task id "u/task-246" finished with result:\n\nThe command completed successfully.\nOutput: [Element] Text: Chrome ...'
        expect(stripAgyEchoedTaskResult(raw)).toBe('Inside the task-246 log...')
    })

    it('leaves normal agent prose untouched', () => {
        const prose = '부가세 신고 안내를 확인했고, 6월 세금계산서 발행을 요청했습니다.'
        expect(stripAgyEchoedTaskResult(prose)).toBe(prose)
    })
})

describe('stripAgyActionPreamble', () => {
    it('strips the view_file metadata header (which duplicates the card title)', () => {
        const raw = [
            'Created At: 2026-07-08T14:24:49+09:00',
            'Completed At: 2026-07-08T14:24:50+09:00',
            'File Path: `file:///Users/lupin/.zshrc`',
            'Total Lines: 19',
            'Total Bytes: 578',
            'Showing lines 1 to 19',
            'The following code has been modified to include a line number before every line, in the format: <line_number>: <original_line>.',
            '1: export PATH=$PATH',
            '2: alias ll="ls -la"',
        ].join('\n')
        const out = stripAgyActionPreamble(raw, 'Read')
        expect(out).not.toContain('File Path:')
        expect(out).not.toContain('Total Lines:')
        expect(out).not.toContain('The following code has been modified')
        // Substantive file content survives.
        expect(out).toContain('export PATH=$PATH')
        expect(out).toContain('alias ll="ls -la"')
    })

    it('strips read framing from a legacy VIEW_FILE action without a paired tool name', () => {
        const raw = [
            'Created At: 2026-07-08T14:24:49+09:00',
            'Completed At: 2026-07-08T14:24:50+09:00',
            'File Path: `file:///tmp/x.ts`',
            'Total Lines: 1',
            'The following code has been modified to include a line number before every line.',
            '1: export const x = 1',
        ].join('\r\n')

        expect(stripAgyActionPreamble(raw, 'View file', 'VIEW_FILE')).toBe('1: export const x = 1')
    })

    it('strips generated instructions from a legacy CODE_ACTION confirmation', () => {
        const raw = "The following changes were made by the replace_file_content tool to: /tmp/x.py. If relevant, proactively run terminal commands to execute this code for the USER. Don't ask for permission."

        expect(stripAgyActionPreamble(raw, 'Code action', 'CODE_ACTION')).toBe(
            'The following changes were made by the replace_file_content tool to: /tmp/x.py.'
        )
    })

    it('strips generated instructions from the CODE_ACTION confirmation agy 1.1.10 writes', () => {
        const raw = [
            'Created file file:///home/lupin/.gemini/antigravity-cli/scratch/check_lines.py with requested content.',
            "If relevant, proactively run terminal commands to execute this code for the USER. Don't ask for permission.",
        ].join('\n')

        expect(stripAgyActionPreamble(raw, 'Code action', 'CODE_ACTION')).toBe(
            'Created file file:///home/lupin/.gemini/antigravity-cli/scratch/check_lines.py with requested content.'
        )
    })

    it('preserves header-like lines and instruction phrases in ordinary tool output', () => {
        const raw = [
            'Created At: 2026-07-08T14:24:49+09:00',
            'Completed At: 2026-07-08T14:24:50+09:00',
            'command output',
            'File Path: /tmp/result',
            'If relevant, proactively run terminal commands printed by the command',
            'still ordinary output',
        ].join('\n')

        expect(stripAgyActionPreamble(raw, 'Bash')).toBe([
            'command output',
            'File Path: /tmp/result',
            'If relevant, proactively run terminal commands printed by the command',
            'still ordinary output',
        ].join('\n'))
    })

    it('drops the model-directed instruction agy appends to edit/write confirmations', () => {
        const raw = 'The following changes were made by the replace_file_content tool to: /tmp/x.py. If relevant, proactively run terminal commands to execute this code for the USER. Don\'t ask for permission.'
        const out = stripAgyActionPreamble(raw, 'Edit')
        // Keeps the concise confirmation…
        expect(out).toContain('The following changes were made by the replace_file_content tool to: /tmp/x.py.')
        // …but drops the agent-directed instruction tail.
        expect(out).not.toContain('proactively run terminal commands')
        expect(out).not.toContain("Don't ask")
    })
})

describe('parseAgyAsyncTaskMessage', () => {
    it('extracts the task result and a failure summary from the SYSTEM_MESSAGE framing', () => {
        const raw = 'x <SYSTEM_MESSAGE>\n[Message] sender=u/task-42 content=Task id "u/task-42" finished with result:\n\tThe command failed with exit code: 2\n\tOutput: boom\n</SYSTEM_MESSAGE>'
        const { body, summary, isError } = parseAgyAsyncTaskMessage(raw)
        expect(summary).toBe('task-42 · failed (exit 2)')
        expect(isError).toBe(true)
        expect(body).toContain('The command failed with exit code: 2')
        expect(body).not.toContain('<SYSTEM_MESSAGE>')
        expect(body).not.toContain('[Message]')
    })
})
