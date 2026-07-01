import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({
    mkdtempSync: vi.fn(() => '/tmp/hapi-claude-cfg-abc'),
    readdirSync: vi.fn(() => ['.credentials.json', 'projects', 'settings.json']),
    symlinkSync: vi.fn(),
    readFileSync: vi.fn(() => JSON.stringify({ projects: { '/other': { hasTrustDialogAccepted: true } } })),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
}))
vi.mock('node:os', () => ({
    homedir: () => '/home/user',
    tmpdir: () => '/tmp',
}))
vi.mock('@/lib', () => ({ logger: { debug: vi.fn() } }))

import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { cleanupTrustedConfigDir, prepareTrustedConfigDir } from '../trustedConfigDir'

function findWrite(suffix: string) {
    return vi.mocked(writeFileSync).mock.calls.find((c) => String(c[0]).endsWith(suffix))
}

describe('prepareTrustedConfigDir', () => {
    beforeEach(() => {
        delete process.env.CLAUDE_CONFIG_DIR
    })
    afterEach(() => {
        vi.clearAllMocks()
    })

    it('symlinks every real config entry into the temp dir', () => {
        prepareTrustedConfigDir('/work')
        expect(symlinkSync).toHaveBeenCalledWith('/home/user/.claude/.credentials.json', '/tmp/hapi-claude-cfg-abc/.credentials.json')
        expect(symlinkSync).toHaveBeenCalledWith('/home/user/.claude/projects', '/tmp/hapi-claude-cfg-abc/projects')
        expect(symlinkSync).toHaveBeenCalledWith('/home/user/.claude/settings.json', '/tmp/hapi-claude-cfg-abc/settings.json')
    })

    it('never symlinks a .claude.json entry (would writethrough to the real file)', () => {
        // A custom CLAUDE_CONFIG_DIR can itself hold a .claude.json. Symlinking it
        // and then writeFileSync-ing the trust-patched copy would follow the link
        // and mutate the real file — so the entry must be skipped, not linked.
        vi.mocked(readdirSync).mockReturnValueOnce(['.credentials.json', '.claude.json'] as never)
        prepareTrustedConfigDir('/work')
        const linkedDotJson = vi.mocked(symlinkSync).mock.calls.find((c) => String(c[1]).endsWith('/.claude.json'))
        expect(linkedDotJson).toBeUndefined()
        // The private copy is still written into the temp dir.
        expect(findWrite('.claude.json')![0]).toBe('/tmp/hapi-claude-cfg-abc/.claude.json')
    })

    it('writes a private .claude.json with the working folder pre-trusted', () => {
        prepareTrustedConfigDir('/work')
        const call = findWrite('.claude.json')
        expect(call).toBeDefined()
        // The copy lives in the temp dir, NOT in the user's home.
        expect(call![0]).toBe('/tmp/hapi-claude-cfg-abc/.claude.json')
        const written = JSON.parse(String(call![1]))
        expect(written.projects['/work'].hasTrustDialogAccepted).toBe(true)
    })

    it('preserves the user\'s existing trusted projects in the copy', () => {
        prepareTrustedConfigDir('/work')
        const written = JSON.parse(String(findWrite('.claude.json')![1]))
        expect(written.projects['/other'].hasTrustDialogAccepted).toBe(true)
    })

    it('never writes to the real ~/.claude.json', () => {
        prepareTrustedConfigDir('/work')
        const homeWrite = vi.mocked(writeFileSync).mock.calls.find((c) => c[0] === '/home/user/.claude.json')
        expect(homeWrite).toBeUndefined()
        // It only reads the real one.
        expect(readFileSync).toHaveBeenCalledWith('/home/user/.claude.json', 'utf-8')
    })

    it('honors an existing CLAUDE_CONFIG_DIR as the real config source', () => {
        process.env.CLAUDE_CONFIG_DIR = '/custom/cfg'
        prepareTrustedConfigDir('/work')
        expect(symlinkSync).toHaveBeenCalledWith('/custom/cfg/.credentials.json', '/tmp/hapi-claude-cfg-abc/.credentials.json')
    })

    it('returns the temp dir path on success', () => {
        expect(prepareTrustedConfigDir('/work')).toBe('/tmp/hapi-claude-cfg-abc')
    })

    it('returns undefined (no throw) when preparation fails', () => {
        vi.mocked(mkdtempSync).mockImplementationOnce(() => { throw new Error('no tmp') })
        expect(prepareTrustedConfigDir('/work')).toBeUndefined()
    })
})

describe('cleanupTrustedConfigDir', () => {
    afterEach(() => vi.clearAllMocks())

    it('recursively removes the temp dir', () => {
        cleanupTrustedConfigDir('/tmp/hapi-claude-cfg-abc')
        expect(rmSync).toHaveBeenCalledWith('/tmp/hapi-claude-cfg-abc', expect.objectContaining({ recursive: true, force: true }))
    })

    it('is a no-op for undefined', () => {
        cleanupTrustedConfigDir(undefined)
        expect(rmSync).not.toHaveBeenCalled()
    })
})

// Archive (KillSession) and SIGTERM/SIGINT end the runner with process.exit(),
// which skips claudePty's finally → cleanupTrustedConfigDir never runs. A
// process 'exit' handler must reap whatever is still pending so /tmp doesn't
// accumulate hapi-claude-cfg-* across sessions.
describe('exit-time reaping of leaked dirs', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        delete process.env.CLAUDE_CONFIG_DIR
    })

    it('registers a process exit handler that reaps still-pending dirs', async () => {
        vi.resetModules()
        const onSpy = vi.spyOn(process, 'on')
        const { prepareTrustedConfigDir } = await import('../trustedConfigDir')
        prepareTrustedConfigDir('/work')
        const exitHandler = onSpy.mock.calls.find((c) => c[0] === 'exit')?.[1] as (() => void) | undefined
        expect(exitHandler).toBeDefined()
        vi.mocked(rmSync).mockClear()
        exitHandler!()
        expect(rmSync).toHaveBeenCalledWith('/tmp/hapi-claude-cfg-abc', expect.objectContaining({ recursive: true, force: true }))
    })

    it('does not reap a dir already cleaned up via cleanupTrustedConfigDir', async () => {
        vi.resetModules()
        const onSpy = vi.spyOn(process, 'on')
        const { prepareTrustedConfigDir, cleanupTrustedConfigDir } = await import('../trustedConfigDir')
        const dir = prepareTrustedConfigDir('/work')
        cleanupTrustedConfigDir(dir)
        const exitHandler = onSpy.mock.calls.find((c) => c[0] === 'exit')?.[1] as (() => void) | undefined
        vi.mocked(rmSync).mockClear()
        exitHandler?.()
        expect(rmSync).not.toHaveBeenCalled()
    })

    it('registers the exit handler only once across multiple prepares', async () => {
        vi.resetModules()
        const onSpy = vi.spyOn(process, 'on')
        const { prepareTrustedConfigDir } = await import('../trustedConfigDir')
        prepareTrustedConfigDir('/a')
        prepareTrustedConfigDir('/b')
        prepareTrustedConfigDir('/c')
        const exitRegistrations = onSpy.mock.calls.filter((c) => c[0] === 'exit')
        expect(exitRegistrations).toHaveLength(1)
    })
})
