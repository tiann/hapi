import { describe, expect, it } from 'vitest'
import { mergeContextDetails, publishContextDetails } from '@/agent/contextDetails'
import type { Metadata } from '@/api/types'
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

    it.each([{ skills: ['automatic-skill'] }, { skills: [] }])('preserves the SDK skill list independently of slash commands: $skills', ({ skills }) => {
        const details = buildClaudeStaticContextDetails({
            sdkMetadata: { slashCommands: ['/compact'], skills },
            catalog: { commands: ['/compact'], skills: [{ name: 'composer-catalog-only' }] }
        })
        expect(details?.claude?.skills).toEqual(skills.map(name => ({ name })))
        expect(details?.claude?.slashCommands).toEqual(['/compact'])
    })

    it('a late startup probe fills missing fields without replacing empty live inventories', () => {
        const pending: Array<(metadata: Metadata) => Metadata> = []
        const client = { updateMetadata: (handler: (metadata: Metadata) => Metadata) => { pending.push(handler) } }
        const probe = buildClaudeStaticContextDetails({
            sdkMetadata: { skills: ['startup-only'], tools: ['StartupTool'], slashCommands: ['/compact'] },
            catalog: { commands: ['/compact'], skills: [] }
        })!
        publishContextDetails(client, { version: 1, provider: 'claude', updatedAt: 100, claude: { skills: [], systemTools: [] } })
        publishContextDetails(client, probe, { claudeStartupCatalog: { tools: ['StartupTool'], slashCommands: ['/compact'] } })
        expect(pending).toHaveLength(2)
        const metadata = pending.reduce((current, update) => update(current), {} as Metadata)
        expect(metadata.contextDetails?.claude).toEqual({ skills: [], systemTools: [], slashCommands: ['/compact'] })
        expect(metadata.tools).toEqual(['StartupTool'])
        expect(metadata.slashCommands).toEqual(['/compact'])
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
