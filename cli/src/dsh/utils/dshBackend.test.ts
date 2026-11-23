import { describe, expect, it } from 'vitest'
import { AcpSdkBackend } from '@/agent/backends/acp'
import { createDshBackend, dshPermissionModeEnvOverlay, resolveDshAcpCommand } from './dshBackend'

describe('resolveDshAcpCommand', () => {
    it('defaults to the official dsh CLI with the ACP profile', () => {
        expect(resolveDshAcpCommand({})).toEqual({
            command: 'dsh',
            args: ['--profile', 'acp']
        })
    })

    it('supports a config path override', () => {
        expect(resolveDshAcpCommand({
            HAPI_DSH_ACP_COMMAND: 'dsh-acp-demo',
            HAPI_DSH_ACP_CONFIG: '/tmp/cordis.yml'
        })).toEqual({
            command: 'dsh-acp-demo',
            args: ['--config', '/tmp/cordis.yml']
        })
    })

    it('maps a config-only override onto the official CLI profile and patch overlay', () => {
        // The official CLI has no `--config` flag: config overlays go through
        // `--patch` on top of a profile, and the ACP server still needs
        // `--profile acp` to boot. `--config` stays a legacy-server escape
        // hatch behind HAPI_DSH_ACP_COMMAND.
        expect(resolveDshAcpCommand({
            HAPI_DSH_ACP_CONFIG: '/tmp/cordis.yml'
        })).toEqual({
            command: 'dsh',
            args: ['--profile', 'acp', '--patch', '/tmp/cordis.yml']
        })
    })

    it('keeps bare arguments for an explicitly configured server', () => {
        // Custom wrappers must not silently receive the official CLI's
        // `--profile acp` flags; they opt into args via ARGS_JSON or CONFIG.
        expect(resolveDshAcpCommand({ HAPI_DSH_ACP_COMMAND: 'dsh-acp-demo' })).toEqual({
            command: 'dsh-acp-demo',
            args: []
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

describe('dshPermissionModeEnvOverlay', () => {
    it('maps read-only onto the DSH read-only sandbox preset', () => {
        expect(dshPermissionModeEnvOverlay('read-only', {})).toEqual({ DSH_PERMISSION_MODE: 'read-only' })
    })

    it('maps yolo onto danger-full-access', () => {
        expect(dshPermissionModeEnvOverlay('yolo', {})).toEqual({ DSH_PERMISSION_MODE: 'danger-full-access' })
    })

    it('leaves the variable unset for default and safe-yolo (server default workspace-write)', () => {
        expect(dshPermissionModeEnvOverlay('default', {})).toEqual({})
        expect(dshPermissionModeEnvOverlay('safe-yolo', {})).toEqual({})
        expect(dshPermissionModeEnvOverlay(undefined, {})).toEqual({})
    })

    it('keeps a machine-level DSH_PERMISSION_MODE authoritative', () => {
        expect(dshPermissionModeEnvOverlay('yolo', { DSH_PERMISSION_MODE: 'read-only' })).toEqual({})
    })
})

describe('createDshBackend spawn configuration', () => {
    it('pins the sandbox preset from the spawn-time permission mode', async () => {
        const backend = createDshBackend({ PATH: '/usr/bin' }, { permissionMode: 'read-only' })
        const options = (backend as unknown as {
            options: { env: Record<string, string | undefined>; flavor?: string }
        }).options

        expect(backend).toBeInstanceOf(AcpSdkBackend)
        expect(options.env.DSH_PERMISSION_MODE).toBe('read-only')
        expect(options.env.PATH).toBe('/usr/bin')
        expect(options.flavor).toBe('dsh')
    })

    it('does not set DSH_PERMISSION_MODE without an explicit mode mapping', () => {
        for (const permissionMode of ['default', 'safe-yolo', undefined]) {
            const backend = createDshBackend({ PATH: '/usr/bin' }, { permissionMode })
            const options = (backend as unknown as { options: { env: Record<string, string | undefined> } }).options
            expect(options.env.DSH_PERMISSION_MODE).toBeUndefined()
        }
    })

    it('maps yolo onto danger-full-access in the child env', () => {
        const backend = createDshBackend({}, { permissionMode: 'yolo' })
        const options = (backend as unknown as { options: { env: Record<string, string | undefined> } }).options
        expect(options.env.DSH_PERMISSION_MODE).toBe('danger-full-access')
    })
})
