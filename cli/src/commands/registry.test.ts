import { describe, expect, it, vi } from 'vitest'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol'
import { resolveCommand } from './registry'

describe('command registry', () => {
    it.each(CREATABLE_AGENT_FLAVORS)('dispatches %s explicitly with its arguments intact', async (agent) => {
        const commandArgs = ['--help', '-h', '--version', '--', 'claude', '--model', 'literal']
        const args = [agent, ...commandArgs]
        const resolved = await resolveCommand(args)

        expect(resolved?.command.name).toBe(agent)
        expect(resolved?.context).toEqual({ args, subcommand: agent, commandArgs })
    })

    it.each([[], ['unknown'], ['--yolo'], ['--resume'], ['a prompt']])(
        'does not fall back to Claude for %j', async (...args) => {
            expect(await resolveCommand(args)).toBeNull()
        }
    )

    it('keeps the hub alias and Gemini tombstone', async () => {
        const server = await resolveCommand(['server'])
        const hub = await resolveCommand(['hub'])

        expect(server?.command.name).toBe('server')
        expect(server?.command.run).toBe(hub?.command.run)
        expect((await resolveCommand(['gemini']))?.command.name).toBe('gemini')
    })

    it('evaluates command modules only when selected', async () => {
        const evaluated: string[] = []
        vi.resetModules()
        vi.doMock('./mcp', async () => {
            evaluated.push('mcp')
            return vi.importActual<typeof import('./mcp')>('./mcp')
        })
        vi.doMock('./runner', async () => {
            evaluated.push('runner')
            return vi.importActual<typeof import('./runner')>('./runner')
        })
        vi.doMock('./resume', async () => {
            evaluated.push('resume')
            return vi.importActual<typeof import('./resume')>('./resume')
        })

        try {
            const { resolveCommand } = await import('./registry')
            expect(evaluated).toEqual([])

            const mcp = await resolveCommand(['mcp'])
            expect(evaluated).toEqual(['mcp'])
            expect(mcp?.command).toBe((await import('./mcp')).mcpCommand)

            const runner = await resolveCommand(['runner', 'status'])
            expect(evaluated).toEqual(['mcp', 'runner'])
            expect(runner?.command).toBe((await import('./runner')).runnerCommand)
        } finally {
            vi.doUnmock('./mcp')
            vi.doUnmock('./runner')
            vi.doUnmock('./resume')
            vi.resetModules()
        }
    })
})
