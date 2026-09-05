import { afterEach, describe, expect, it, vi } from 'vitest'

const { initializeTokenMock, spawnPeerMock } = vi.hoisted(() => ({
    initializeTokenMock: vi.fn(async () => {}),
    spawnPeerMock: vi.fn()
}))

vi.mock('@/modules/spawnPeer/spawnPeer', async () => {
    const actual = await vi.importActual<typeof import('@/modules/spawnPeer/spawnPeer')>(
        '@/modules/spawnPeer/spawnPeer'
    )
    return { ...actual, spawnPeer: spawnPeerMock }
})

vi.mock('@/ui/tokenInit', async () => {
    const actual = await vi.importActual<typeof import('@/ui/tokenInit')>('@/ui/tokenInit')
    return { ...actual, initializeToken: initializeTokenMock }
})

import { SpawnPeerError } from '@/modules/spawnPeer/spawnPeer'
import { handleSpawnPeerCommand, parseSpawnPeerArgs, spawnPeerCommand } from './spawnPeer'

afterEach(() => {
    initializeTokenMock.mockClear()
    spawnPeerMock.mockReset()
    vi.restoreAllMocks()
})

describe('parseSpawnPeerArgs', () => {
    it('parses --dir, --name, and positional message', () => {
        expect(parseSpawnPeerArgs([
            '--dir', '/tmp/project',
            '--name', 'Peer',
            'hello remit'
        ])).toEqual({
            help: false,
            json: false,
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
            json: false,
            directory: '/tmp/wt',
            name: 'Peer',
            messageFile: 'brief.md',
            agent: 'cursor',
            sessionType: 'worktree',
            waitActiveSecs: 30
        })
    })

    it('parses automation options', () => {
        expect(parseSpawnPeerArgs([
            '--json', '--dir=/remote/repo', '--name=Peer', '--machine=runner-2',
            '--model=gpt-5', '--effort=high',
            '--remit-id=7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c', 'work'
        ])).toMatchObject({
            json: true,
            machineId: 'runner-2',
            model: 'gpt-5',
            effort: 'high',
            remitId: '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        })
    })

    it('parses --help', () => {
        expect(parseSpawnPeerArgs(['--help']).help).toBe(true)
    })

    it('rejects unknown flags', () => {
        expect(() => parseSpawnPeerArgs(['--host', 'evil'])).toThrow(SpawnPeerError)
        expect(() => parseSpawnPeerArgs(['--wait', '--json'])).toThrow(SpawnPeerError)
        expect(() => parseSpawnPeerArgs(['--remit-id='])).toThrow(SpawnPeerError)
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

    it('includes the retryable remit id in JSON after ambiguous transport failure', async () => {
        const remitId = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        spawnPeerMock.mockRejectedValueOnce(new SpawnPeerError('spawn_failed', 'socket reset', remitId))
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(process, 'exit').mockImplementation((code) => {
            throw new Error(`process.exit:${code}`)
        })

        await expect(spawnPeerCommand.run({
            args: [],
            subcommand: 'spawn-peer',
            commandArgs: [
                '--json',
                '--dir', '/tmp/project',
                '--name', 'Worker',
                'do the work'
            ]
        })).rejects.toThrow('process.exit:3')
        expect(log).toHaveBeenCalledWith(JSON.stringify({
            ok: false,
            remitId,
            error: { code: 'spawn_failed', message: 'socket reset' }
        }))
    })
})
