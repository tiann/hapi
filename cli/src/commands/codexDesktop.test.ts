import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureDesktop } from './codexDesktop'

describe.skipIf(process.platform === 'win32')('macOS desktop setup', () => {
    const launchctl = '/bin/launchctl'
    const flag = 'CODEX_APP_SERVER_USE_LOCAL_DAEMON'
    const ownerFlag = 'HAPI_CODEX_DESKTOP_DAEMON_FLAG_OWNER'
    const label = 'com.hapi.chatgpt-desktop'
    const uid = process.getuid?.() ?? -1
    const domain = `gui/${uid}`
    const target = `${domain}/${label}`
    const asuser = ['asuser', String(uid)]
    let homedir: string
    let plistPath: string
    let loaded: boolean
    const guiEnv = new Map<string, string>()
    let bootstrapFails: boolean
    let daemonFails: boolean
    let quitFails: boolean

    const run = vi.fn(async (file: string, args: string[]) => {
        expect(file).toBe(launchctl)
        if (args[0] === 'asuser') {
            expect(args.slice(0, 2)).toEqual(asuser)
            const [, , program, command, ...values] = args
            if (program === '/bin/sh' && daemonFails) throw new Error('daemon failed')
            if (program === '/usr/bin/osascript' && quitFails) throw new Error('quit denied')
            if (program === launchctl) {
                if (command === 'managername') return 'Aqua'
                if (command === 'getenv') return guiEnv.get(values[0]) ?? ''
                if (command === 'setenv') {
                    for (let i = 0; i < values.length; i += 2) guiEnv.set(values[i], values[i + 1])
                }
                if (command === 'unsetenv') values.forEach(key => guiEnv.delete(key))
            }
        } else if (args[0] === 'print' && !loaded) {
            throw Object.assign(new Error('could not find service'), { code: 113 })
        } else if (args[0] === 'bootstrap') {
            if (bootstrapFails) throw new Error('bootstrap denied')
            loaded = true
        } else if (args[0] === 'bootout') {
            loaded = false
        }
        return ''
    })

    const configure = (action: 'setup' | 'remove' = 'setup', restart = false) => configureDesktop(action, restart, { uid, homedir }, run, {
        command: '/path/to/hapi', args: ['codex-desktop', '_sync'], hapiHome: join(homedir, '.hapi')
    })

    beforeEach(async () => {
        homedir = await mkdtemp(join(tmpdir(), `hapi-desktop & O'Brien-`))
        plistPath = join(homedir, 'Library', 'LaunchAgents', `${label}.plist`)
        loaded = false
        guiEnv.clear()
        bootstrapFails = daemonFails = quitFails = false
        run.mockClear()
    })
    afterEach(async () => { await rm(homedir, { recursive: true, force: true }) })

    it('starts the daemon, installs an Aqua login job, and sets the flag before restarting', async () => {
        const output = await configure('setup', true)
        const plist = await readFile(plistPath, 'utf8')
        expect(plist).toContain('<key>RunAtLoad</key><true/>')
        expect(plist).toContain('<key>LimitLoadToSessionType</key><string>Aqua</string>')
        expect(plist).toContain('<key>AbandonProcessGroup</key><true/>')
        expect(plist).toContain('hapi-desktop &amp; O\'Brien-')
        expect(plist).toContain(`/bin/launchctl setenv ${flag} 1 ${ownerFlag} 1`)
        expect(plist).toContain('<key>KeepAlive</key>')
        expect(plist).toContain('<string>/path/to/hapi</string>')
        expect(plist).toContain('<string>_sync</string>')
        expect(plist).toContain('unset CLI_API_TOKEN HAPI_API_URL HAPI_EXTRA_HEADERS_JSON')
        expect((await lstat(plistPath)).mode & 0o777).toBe(0o600)
        expect(run.mock.calls).toEqual([
            [launchctl, [...asuser, launchctl, 'managername']],
            [launchctl, ['print', target]],
            [launchctl, [...asuser, '/bin/sh', '-c', expect.stringContaining('app-server daemon start'), label, expect.stringContaining('/ChatGPT.app/'), join(homedir, '.codex'), 'start-only']],
            [launchctl, ['bootstrap', domain, plistPath]],
            [launchctl, [...asuser, launchctl, 'getenv', flag]],
            [launchctl, [...asuser, launchctl, 'setenv', flag, '1', ownerFlag, '1']],
            [launchctl, [...asuser, '/usr/bin/osascript', '-l', 'JavaScript', '-e', expect.stringContaining('app.terminate')]],
            [launchctl, [...asuser, '/usr/bin/open', '/Applications/ChatGPT.app']]
        ])
        expect(output).toContain('appear automatically in HAPI')
        expect(output).not.toContain('hapi attach')
    })

    it('is repeatable and does not quit the app without --restart', async () => {
        await configure()
        const content = await readFile(plistPath, 'utf8')
        run.mockClear()
        expect(await configure()).toContain('Quit and reopen ChatGPT when ready')
        expect(await readFile(plistPath, 'utf8')).toBe(content)
        expect(run.mock.calls.flat(2)).not.toContain('bootstrap')
        expect(run.mock.calls.flat(2)).not.toContain('/usr/bin/osascript')
    })

    it('unloads and removes its own login job and flag, leaving the daemon and app alone', async () => {
        await configure()
        run.mockClear()
        expect(await configure('remove')).toContain('daemon was left intact')
        await expect(lstat(plistPath)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(run.mock.calls).toEqual([
            [launchctl, [...asuser, launchctl, 'managername']],
            [launchctl, ['print', target]],
            [launchctl, ['bootout', target]],
            [launchctl, [...asuser, launchctl, 'getenv', ownerFlag]],
            [launchctl, [...asuser, launchctl, 'getenv', flag]],
            [launchctl, [...asuser, launchctl, 'unsetenv', flag, ownerFlag]]
        ])
        expect(guiEnv.size).toBe(0)
        expect(await configure('remove')).toContain('No HAPI desktop setup')
    })

    it('can restart ChatGPT after removal, but never restarts if there was nothing to remove', async () => {
        await configure()
        run.mockClear()
        expect(await configure('remove', true)).toContain('ChatGPT was reopened')
        expect(run.mock.calls.slice(-3)).toEqual([
            [launchctl, [...asuser, launchctl, 'unsetenv', flag, ownerFlag]],
            [launchctl, [...asuser, '/usr/bin/osascript', '-l', 'JavaScript', '-e', expect.stringContaining('app.terminate')]],
            [launchctl, [...asuser, '/usr/bin/open', '/Applications/ChatGPT.app']]
        ])
        run.mockClear()
        await configure('remove', true)
        expect(run.mock.calls.flat(2)).not.toContain('/usr/bin/osascript')
    })

    it('leaves an existing manual GUI setting intact on removal', async () => {
        guiEnv.set(flag, '1')
        await configure()
        expect(guiEnv.has(ownerFlag)).toBe(false)
        await configure('remove')
        expect(guiEnv.get(flag)).toBe('1')
    })

    it('preserves a flag that has since been changed', async () => {
        await configure()
        guiEnv.set(flag, '0')
        await configure('remove')
        expect(guiEnv.get(flag)).toBe('0')
        expect(guiEnv.has(ownerFlag)).toBe(false)
    })

    it('refuses to overwrite a foreign file or remove a symlink', async () => {
        await configure()
        await writeFile(plistPath, 'foreign')
        run.mockClear()
        await expect(configure()).rejects.toThrow('unrecognized LaunchAgent')
        const otherFile = join(homedir, 'other.plist')
        await writeFile(otherFile, 'foreign')
        await rm(plistPath)
        await symlink(otherFile, plistPath)
        await expect(configure('remove')).rejects.toThrow('unrecognized LaunchAgent')
        expect(await readFile(otherFile, 'utf8')).toBe('foreign')
        expect(run).not.toHaveBeenCalled()
    })

    it('does not install a login job when daemon preparation fails', async () => {
        daemonFails = true
        await expect(configure()).rejects.toThrow('daemon failed')
        await expect(lstat(plistPath)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(guiEnv.size).toBe(0)
    })

    it('cleans up an unsuccessful first bootstrap without setting the flag', async () => {
        bootstrapFails = true
        await expect(configure()).rejects.toThrow('bootstrap denied')
        await expect(lstat(plistPath)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(guiEnv.size).toBe(0)
    })

    it('does not reopen ChatGPT if the graceful quit fails and keeps the installed setup', async () => {
        quitFails = true
        await expect(configure('setup', true)).rejects.toThrow('Setup is installed, but ChatGPT could not be restarted')
        expect((await lstat(plistPath)).isFile()).toBe(true)
        expect(run.mock.calls.flat(2)).not.toContain('/usr/bin/open')
    })
})
