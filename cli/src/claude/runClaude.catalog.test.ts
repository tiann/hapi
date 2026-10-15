import { describe, expect, it } from 'vitest'
import { mergeContextDetails } from '@/agent/contextDetails'
import { buildClaudeStaticContextDetails } from './runClaude'

describe('Claude static context catalog', () => {
    it('does not erase saved commands and skills when catalog discovery is unavailable', () => {
        const previous = {
            version: 1 as const,
            updatedAt: 100,
            provider: 'claude' as const,
            claude: {
                skills: [{ name: 'existing-skill' }],
                slashCommands: ['/existing']
            }
        }
        const next = buildClaudeStaticContextDetails({
            model: 'claude-opus',
            sdkMetadata: {
                tools: ['Read'],
                slashCommands: undefined
            },
            catalog: {
                commands: [],
                skills: [{ name: 'discovered-skill' }]
            }
        })

        expect(next).toMatchObject({
            claude: { systemTools: ['Read'] }
        })
        expect(next?.claude).not.toHaveProperty('skills')
        expect(next?.claude).not.toHaveProperty('slashCommands')
        expect(mergeContextDetails(previous, next!)).toMatchObject({
            claude: {
                systemTools: ['Read'],
                skills: [{ name: 'existing-skill' }],
                slashCommands: ['/existing']
            }
        })
    })
})
