import { describe, expect, it } from 'vitest'
import { SpawnPeerError } from '@/modules/spawnPeer/spawnPeer'
import { handleSpawnPeerCommand, parseSpawnPeerArgs } from './spawnPeer'

describe('parseSpawnPeerArgs', () => {
    it('parses --dir, --name, and positional message', () => {
        expect(parseSpawnPeerArgs([
            '--dir', '/tmp/project',
            '--name', 'Peer',
            'hello remit'
        ])).toEqual({
            help: false,
            directory: '/tmp/project',
            name: 'Peer',
            message: 'hello remit'
        })
    })

    it('parses --message-file, --agent, --session-type, and --wait', () => {
        expect(parseSpawnPeerArgs([
            '--dir', '/tmp/wt',
            '--name', 'Peer',
            '--message-file', 'brief.md',
            '--agent', 'cursor',
            '--session-type', 'worktree',
            '--wait', '30'
        ])).toEqual({
            help: false,
            directory: '/tmp/wt',
            name: 'Peer',
            messageFile: 'brief.md',
            agent: 'cursor',
            sessionType: 'worktree',
            waitActiveSecs: 30
        })
    })

    it('parses --machine UUID or hostname', () => {
        expect(parseSpawnPeerArgs([
            '--dir', '/tmp/wt',
            '--name', 'Peer',
            '--machine', 'oos-llm-lab',
            'hello remit'
        ])).toEqual({
            help: false,
            directory: '/tmp/wt',
            name: 'Peer',
            machine: 'oos-llm-lab',
            message: 'hello remit'
        })
        expect(parseSpawnPeerArgs([
            '--dir=/tmp/wt',
            '--name=Peer',
            '--machine=5f5a87e8-25b2-4732-ba4c-aba95f695bd7',
            'hello'
        ]).machine).toBe('5f5a87e8-25b2-4732-ba4c-aba95f695bd7')
    })

    it('parses --help', () => {
        expect(parseSpawnPeerArgs(['--help']).help).toBe(true)
    })

    it('rejects unknown flags', () => {
        expect(() => parseSpawnPeerArgs(['--host', 'evil'])).toThrow(SpawnPeerError)
    })

    it('rejects --session-type other than simple|worktree', () => {
        expect(() => parseSpawnPeerArgs([
            '--dir', '/tmp/x',
            '--name', 'P',
            '--session-type', 'relocate'
        ])).toThrow(SpawnPeerError)
    })
})

describe('handleSpawnPeerCommand', () => {
    it('rejects --name over 255 characters before touching the hub', async () => {
        await expect(handleSpawnPeerCommand([
            '--dir', '/tmp/project',
            '--name', 'n'.repeat(256),
            'do the work'
        ])).rejects.toMatchObject({ code: 'bad_args' })
    })
})
