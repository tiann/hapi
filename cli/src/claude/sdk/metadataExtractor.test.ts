import { describe, expect, it } from 'vitest'
import {
    classifyClaudeSlashCatalog,
    filterCatalogAffectingClaudeArgs
} from './metadataExtractor'

describe('Claude skill catalog', () => {
    const discoveredSkills = [
        { name: 'hapi', description: 'Manage HAPI' },
        { name: 'ponytail', description: 'Keep code simple' },
        { name: 'scanner-only', description: 'Not loaded by Claude' }
    ]

    it('separates native skills from slash commands and keeps plugin namespaces', () => {
        expect(classifyClaudeSlashCatalog(
            ['help', 'hapi', 'url-plugin:url-skill', 'ponytail:ponytail', 'review'],
            discoveredSkills,
            ['hapi', 'url-plugin:url-skill', 'ponytail:ponytail']
        )).toEqual({
            commands: ['help', 'review'],
            skills: [
                { name: 'hapi', description: 'Manage HAPI' },
                { name: 'url-plugin:url-skill', description: undefined },
                { name: 'ponytail:ponytail', description: 'Keep code simple' }
            ]
        })
    })

    it('keeps only launch arguments that affect the command catalog', () => {
        expect(filterCatalogAffectingClaudeArgs([
            '--resume', 'session-id',
            '--plugin-dir', '/tmp/my plugin',
            '--settings=/tmp/settings.json',
            '--add-dir', '/tmp/one', '/tmp/two',
            '--disable-slash-commands',
            '--model', 'sonnet'
        ])).toEqual([
            '--plugin-dir', '/tmp/my plugin',
            '--settings=/tmp/settings.json',
            '--add-dir', '/tmp/one', '/tmp/two',
            '--disable-slash-commands'
        ])
    })

})
