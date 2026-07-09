import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildRunnerServiceCommand, getRunnerServiceStatus, renderMacOSLaunchAgent, renderSystemdUserUnit } from './service'

describe('runner service templates', () => {
    const originalPath = process.env.PATH
    const originalHapiHome = process.env.HAPI_HOME

    afterEach(() => {
        vi.unstubAllEnvs()
        process.env.PATH = originalPath
        if (originalHapiHome === undefined) {
            delete process.env.HAPI_HOME
        } else {
            process.env.HAPI_HOME = originalHapiHome
        }
    })

    it('renders a macOS LaunchAgent that keeps the runner alive after login', () => {
        vi.stubEnv('PATH', '/opt/homebrew/bin:/usr/local/bin:/usr/bin')
        vi.stubEnv('HAPI_HOME', '/Users/me/.hapi')

        const plist = renderMacOSLaunchAgent({
            command: '/usr/local/bin/hapi',
            args: ['runner', 'start-sync', '--workspace-root', '/Users/me/project & docs']
        }, '/Users/me/.hapi/logs/runner-service.log')

        expect(plist).toContain('<string>com.hapi.runner</string>')
        expect(plist).toContain('<key>RunAtLoad</key>')
        expect(plist).toContain('<key>KeepAlive</key>')
        expect(plist).toContain('<key>SuccessfulExit</key>')
        expect(plist).toContain('<false/>')
        expect(plist).toContain('<string>runner</string>')
        expect(plist).toContain('<string>start-sync</string>')
        expect(plist).toContain('<string>/Users/me/project &amp; docs</string>')
        expect(plist).toContain('<key>HAPI_DISABLE_VERSION_HANDOFF</key>')
        expect(plist).toContain('<string>1</string>')
        expect(plist).toContain('<key>HAPI_HOME</key>')
        expect(plist).toContain('<string>/Users/me/.hapi</string>')
    })

    it('renders a systemd user unit with process-only shutdown semantics', () => {
        vi.stubEnv('PATH', '/usr/local/bin:/usr/bin')
        vi.stubEnv('HAPI_HOME', '/home/me/.hapi')

        const unit = renderSystemdUserUnit({
            command: '/usr/local/bin/hapi',
            args: ['runner', 'start-sync', '--workspace-root', '/home/me/project with spaces']
        })

        expect(unit).toContain('Description=HAPI Runner')
        expect(unit).toContain('KillMode=process')
        expect(unit).toContain('Restart=on-failure')
        expect(unit).toContain('ExecStart=/usr/local/bin/hapi runner start-sync --workspace-root "/home/me/project with spaces"')
        expect(unit).toContain('Environment="HAPI_DISABLE_VERSION_HANDOFF=1"')
        expect(unit).toContain('Environment="HAPI_HOME=/home/me/.hapi"')
    })

    it('builds start-sync command with repeated workspace roots', () => {
        const command = buildRunnerServiceCommand(['/one', '/two'])
        expect(command.args).toContain('runner')
        expect(command.args).toContain('start-sync')
        expect(command.args.join('\n')).toContain('/one')
        expect(command.args.join('\n')).toContain('/two')
    })

    it('prefers a PATH hapi wrapper for OS services', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-service-test-'))
        try {
            const wrapper = join(dir, 'hapi')
            writeFileSync(wrapper, '#!/bin/sh\nexit 0\n')
            chmodSync(wrapper, 0o755)
            vi.stubEnv('PATH', dir)

            const command = buildRunnerServiceCommand(['/workspace'])

            expect(command.command).toBe(wrapper)
            expect(command.args).toEqual(['runner', 'start-sync', '--workspace-root', '/workspace'])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('delegates service status to the native helper when available', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-native-test-'))
        try {
            const helper = join(dir, 'hapi-local')
            writeFileSync(helper, '#!/bin/sh\nexit 0\n')
            chmodSync(helper, 0o755)
            vi.stubEnv('HAPI_NATIVE_HELPER', helper)

            const execFile = vi.fn(async () => ({
                stdout: '{"servicePath":"/service/path","status":"native status"}',
                stderr: ''
            }))

            await expect(getRunnerServiceStatus({ execFile })).resolves.toBe('native status')
            expect(execFile).toHaveBeenCalledOnce()
            const calls = execFile.mock.calls as unknown as Array<[string, string[]]>
            expect(calls[0]?.[0]).toBe(helper)
            expect(calls[0]?.[1]).toContain('status')
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
