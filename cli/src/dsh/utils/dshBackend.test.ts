import { describe, expect, it } from 'vitest'
import { resolveDshAcpCommand } from './dshBackend'

describe('resolveDshAcpCommand', () => {
    it('uses the official ACP demo executable by default', () => {
        expect(resolveDshAcpCommand({})).toEqual({
            command: 'dsh-acp-demo',
            args: []
        })
    })

    it('supports a config path for dsh-acp-demo', () => {
        expect(resolveDshAcpCommand({ HAPI_DSH_ACP_CONFIG: '/tmp/cordis.yml' })).toEqual({
            command: 'dsh-acp-demo',
            args: ['--config', '/tmp/cordis.yml']
        })
    })

    it('supports source checkouts and community servers through JSON args', () => {
        expect(resolveDshAcpCommand({
            HAPI_DSH_ACP_COMMAND: 'pnpm',
            HAPI_DSH_ACP_ARGS_JSON: '["--dir", "/opt/dsh", "run", "demo:acp"]'
        })).toEqual({
            command: 'pnpm',
            args: ['--dir', '/opt/dsh', 'run', 'demo:acp']
        })
    })

    it('rejects shell-like or malformed argument values', () => {
        expect(() => resolveDshAcpCommand({ HAPI_DSH_ACP_ARGS_JSON: 'pnpm --dir /opt/dsh' }))
            .toThrow('HAPI_DSH_ACP_ARGS_JSON must be a JSON array of strings')
        expect(() => resolveDshAcpCommand({ HAPI_DSH_ACP_ARGS_JSON: '["pnpm", 1]' }))
            .toThrow('HAPI_DSH_ACP_ARGS_JSON must be a JSON array of strings')
    })
})
