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

    it('does not overwrite the resolved runtime model or context window', () => {
        const previous = {
            version: 1 as const,
            updatedAt: 100,
            provider: 'claude' as const,
            model: 'claude-sonnet-5-5',
            contextWindow: 1_000_000,
            usage: { contextTokens: 26_697 },
            claude: {
                skills: [{ name: 'runtime-skill' }]
            }
        }
        const next = buildClaudeStaticContextDetails({
            model: 'sonnet',
            sdkMetadata: {
                tools: ['Read'],
                slashCommands: ['/compact']
            },
            catalog: {
                commands: ['/compact'],
                skills: [{ name: 'catalog-skill' }]
            }
        })!

        const merged = mergeContextDetails(previous, next)

        expect(merged).toMatchObject({
            model: 'claude-sonnet-5-5',
            contextWindow: 1_000_000,
            usage: { contextTokens: 26_697 },
            claude: {
                systemTools: ['Read'],
                skills: [{ name: 'catalog-skill' }],
                slashCommands: ['/compact']
            }
        })
    })
})
