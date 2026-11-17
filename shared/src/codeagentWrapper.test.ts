import { describe, expect, it } from 'bun:test'
import {
    extractCodeagentWrapperSessionIds,
    getNativeAgentSessionIds,
    mapWrapperBackendToHapiFlavor,
    parseCodeagentWrapperCommand,
} from './codeagentWrapper'

describe('codeagentWrapper helpers', () => {
    it('maps antigravity wrapper backend to agy flavor and keeps others unchanged', () => {
        expect(mapWrapperBackendToHapiFlavor('antigravity')).toBe('agy')
        expect(mapWrapperBackendToHapiFlavor('codex')).toBe('codex')
        expect(mapWrapperBackendToHapiFlavor('opencode')).toBe('opencode')
    })

    it('parses single and resumed codeagent-wrapper invocations', () => {
        const cmd = `/home/ubuntu/.claude/bin/codeagent-wrapper --progress --backend codex - "/work/repo" <<'EOF'\nROLE_FILE: ~/.claude/.ccg/prompts/codex/reviewer.md\nReview\nEOF`
        expect(parseCodeagentWrapperCommand(cmd)).toEqual({
            backend: 'codex',
            flavor: 'codex',
            role: 'reviewer',
            resumedSessionId: null,
            isParallel: false,
        })

        const resumed = `codeagent-wrapper --backend antigravity resume thread-abc123 - "/work/repo"`
        expect(parseCodeagentWrapperCommand(resumed)).toEqual({
            backend: 'antigravity',
            flavor: 'agy',
            role: null,
            resumedSessionId: 'thread-abc123',
            isParallel: false,
        })
    })

    it('ignores plain shell commands that merely list or inspect codeagent-wrapper', () => {
        expect(parseCodeagentWrapperCommand('ls -la /home/ubuntu/.claude/bin/codeagent-wrapper')).toBeNull()
        expect(parseCodeagentWrapperCommand('cat codeagent-wrapper/main.go')).toBeNull()
    })

    it('extracts deduplicated SESSION_ID values only after the canonical footer', () => {
        const out = [
            'Some prose mentioning SESSION_ID: fake-id-without-footer',
            '---',
            'SESSION_ID: 019a0000-1111-7222-8333-444455556666',
            '---',
            'SESSION_ID: 019a0000-1111-7222-8333-444455556666',
            '---',
            'SESSION_ID: ses_second_worker_99',
        ].join('\n')
        expect(extractCodeagentWrapperSessionIds(out)).toEqual([
            '019a0000-1111-7222-8333-444455556666',
            'ses_second_worker_99',
        ])
    })

    it('collects unique native agent session IDs from metadata', () => {
        expect(getNativeAgentSessionIds({
            codexSessionId: 'thread-1',
            agentSessionId: 'thread-1',
            agySessionId: 'agy-2',
        })).toEqual(['thread-1', 'agy-2'])
        expect(getNativeAgentSessionIds(null)).toEqual([])
    })
})
