import { describe, expect, it } from 'vitest'
import { parseAgentTimestampMs } from '@/chat/agentTimestamp'

describe('parseAgentTimestampMs', () => {
    it('parses a valid ISO-8601 timestamp to epoch ms', () => {
        // Real shape emitted by the Claude CLI's sdkToLogConverter (data.timestamp).
        expect(parseAgentTimestampMs('2026-07-13T14:37:57.372Z')).toBe(Date.parse('2026-07-13T14:37:57.372Z'))
    })

    it('returns null when the value is undefined (field absent)', () => {
        expect(parseAgentTimestampMs(undefined)).toBeNull()
    })

    it('returns null when the value is not a string', () => {
        expect(parseAgentTimestampMs(1783953477372)).toBeNull()
    })

    it('returns null for an unparseable string', () => {
        expect(parseAgentTimestampMs('not-a-timestamp')).toBeNull()
    })

    it('returns null for an empty string', () => {
        expect(parseAgentTimestampMs('')).toBeNull()
    })
})
