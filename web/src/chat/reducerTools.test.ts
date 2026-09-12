import { describe, expect, it } from 'vitest'
import { permissionCases } from '../../scripts/fixtures/cases/permissions'
import { normalizeDecryptedMessage } from './normalize'
import { reduceChatBlocks } from './reducer'
import { getPermissions } from './reducerTools'
import type { NormalizedMessage } from './types'

describe('local permission identity', () => {
    it.each(['pending', 'synthesized', 'completed'])('renders a single %s question card with the independent reply ID', state => {
        const fixture = permissionCases.find(item => item.name === `permission-local-question-${state}`)!
        const messages = fixture.messages.map(normalizeDecryptedMessage).filter((item): item is NormalizedMessage => item !== null)
        const tools = reduceChatBlocks(messages, fixture.agentState).blocks.filter(block => block.kind === 'tool-call')
        expect(tools).toHaveLength(1)
        expect(tools[0]).toMatchObject({ id: 'toolu_local_question', tool: {
            id: 'toolu_local_question', name: 'AskUserQuestion', state: state === 'completed' ? 'completed' : state === 'synthesized' ? 'pending' : 'running',
            permission: { id: 'claude-local:reply-1', status: state === 'completed' ? 'approved' : 'pending' }
        } })
        if (state === 'completed') expect(tools[0].tool.permission?.answers).toEqual({ '0': ['Postgres'] })
    })

    it('gives a new pending reply precedence over an earlier completed reply for the same tool', () => {
        const entry = { tool: 'Bash', toolCallId: 'tool-1', arguments: {} }
        const completed = { ...entry, status: 'canceled' as const }
        const permissions = getPermissions({
            requests: { old: entry, next: entry },
            completedRequests: { old: completed }
        })
        expect(permissions.size).toBe(1)
        expect(permissions.get('tool-1')?.permission).toMatchObject({ id: 'next', status: 'pending' })
        expect(getPermissions({ requests: { old: entry }, completedRequests: { old: completed } }).get('tool-1')?.permission.status).toBe('canceled')
    })
})
