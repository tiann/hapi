import { describe, expect, it } from 'vitest'
import { CREATABLE_AGENT_FLAVORS } from '@hapi/protocol'
import { resolveCommand } from './registry'

describe('command registry', () => {
    it.each(CREATABLE_AGENT_FLAVORS)('dispatches %s explicitly with its arguments intact', (agent) => {
        const commandArgs = ['--help', '-h', '--version', '--', 'claude', '--model', 'literal']
        const args = [agent, ...commandArgs]
        const resolved = resolveCommand(args)

        expect(resolved?.command.name).toBe(agent)
        expect(resolved?.context).toEqual({ args, subcommand: agent, commandArgs })
    })

    it.each([[], ['unknown'], ['--yolo'], ['--resume'], ['a prompt']])(
        'does not fall back to Claude for %j', (...args) => {
            expect(resolveCommand(args)).toBeNull()
        }
    )

    it('keeps the hub alias and Gemini tombstone', () => {
        expect(resolveCommand(['server'])?.command.run).toBe(resolveCommand(['hub'])?.command.run)
        expect(resolveCommand(['gemini'])?.command.name).toBe('gemini')
    })
})
