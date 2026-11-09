import { describe, expect, it } from 'vitest'
import { resolveBerryAcpCommand } from './berryBackend'

describe('resolveBerryAcpCommand', () => {
    it('defaults to the berry CLI with the acp subcommand', () => {
        expect(resolveBerryAcpCommand({})).toEqual({
            command: 'berry',
            args: ['acp']
        })
    })

    it('keeps bare arguments for an explicitly configured server', () => {
        // Custom wrappers must not silently receive the official CLI's
        // `acp` subcommand; they opt into args via ARGS_JSON.
        expect(resolveBerryAcpCommand({ HAPI_BERRY_ACP_COMMAND: 'berry-acp-demo' })).toEqual({
            command: 'berry-acp-demo',
            args: []
        })
    })

    it('supports source checkouts and community servers through JSON args', () => {
        expect(resolveBerryAcpCommand({
            HAPI_BERRY_ACP_COMMAND: 'pnpm',
            HAPI_BERRY_ACP_ARGS_JSON: '["--dir", "/opt/berry", "run", "acp"]'
        })).toEqual({
            command: 'pnpm',
            args: ['--dir', '/opt/berry', 'run', 'acp']
        })
    })

    it('rejects shell-like or malformed argument values', () => {
        expect(() => resolveBerryAcpCommand({ HAPI_BERRY_ACP_ARGS_JSON: 'berry acp' }))
            .toThrow('HAPI_BERRY_ACP_ARGS_JSON must be a JSON array of strings')
        expect(() => resolveBerryAcpCommand({ HAPI_BERRY_ACP_ARGS_JSON: '["berry", 1]' }))
            .toThrow('HAPI_BERRY_ACP_ARGS_JSON must be a JSON array of strings')
    })
})
