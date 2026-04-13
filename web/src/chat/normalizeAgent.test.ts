import { describe, expect, it } from 'vitest'
import { normalizeAgentRecord } from '@/chat/normalizeAgent'

describe('normalizeAgentRecord', () => {
    it('drops invalid permission mode values from tool-result permissions', () => {
        const normalized = normalizeAgentRecord(
            'message-1',
            null,
            1,
            {
                type: 'output',
                data: {
                    type: 'user',
                    message: {
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: 'tool-1',
                            content: 'ok',
                            permissions: {
                                date: 1,
                                result: 'approved',
                                mode: 'not-a-real-mode',
                                implementationMode: 'not-a-real-implementation-mode'
                            }
                        }]
                    }
                }
            }
        )

        expect(normalized?.role).toBe('agent')
        if (!normalized || normalized.role !== 'agent') {
            throw new Error('Expected normalized agent message')
        }

        expect(normalized.content[0]).toMatchObject({
            type: 'tool-result',
            tool_use_id: 'tool-1'
        })
        expect((normalized.content[0] as { permissions?: { mode?: unknown; implementationMode?: unknown } }).permissions).toEqual({
            date: 1,
            result: 'approved',
            decision: undefined,
            allowedTools: undefined,
            mode: undefined,
            implementationMode: undefined
        })
    })
})
