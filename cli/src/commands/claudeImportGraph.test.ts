import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads the runner-side Claude runtime without terminal UI or other launchers', () => {
    const home = mkdtempSync(join(tmpdir(), 'hapi-import-graph-'))
    try {
        const output = execFileSync('bun', ['-e', `
            if (process.stdin.isTTY || process.stdout.isTTY) throw new Error('expected headless stdio')
            const { resolveCommand } = await import('./src/commands/registry')
            await resolveCommand(['claude', '--started-by', 'runner'])
            const command = Object.keys(require.cache)
            await import('./src/claude/runClaude')
            await import('./src/commands/resume')
            console.log(JSON.stringify([command, Object.keys(require.cache)]))
        `], {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            env: { ...process.env, HAPI_HOME: home },
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024
        })
        const [command, runtime] = (JSON.parse(output) as string[][])
            .map(paths => paths.map(path => path.split('\\').join('/')))
        const otherFlavor = /\/cli\/src\/(?:commands\/)?(?:agy|codex|copilot|cursor|dsh|grok|kimi|opencode|pi)(?:\/|\.ts$)/
        expect(command.some(path => path.endsWith('/commands/claude.ts'))).toBe(true)
        expect(command.filter(path => otherFlavor.test(path))).toEqual([])
        for (const file of ['claude/runClaude', 'claude/loop', 'claude/claudeRemoteLauncher', 'modules/common/remote/RemoteLauncherBase', 'commands/resume']) {
            expect(runtime.some(path => path.endsWith('/src/' + file + '.ts'))).toBe(true)
        }
        expect(runtime.filter(path =>
            /\/node_modules\/(?:react|ink)\/|\/(?:hub|web)\/src\/|\/commands\/hub\.ts$|\/ui\/ink\/(?:RemoteModeDisplay|ResumeSessionPicker)\.|\/claude\/claudeLocalLauncher\./.test(path)
            || (otherFlavor.test(path) && /(?:Launcher|\/loop|\/run[A-Z]\w*|\/shared\/(?:frontend|runtime))\.tsx?$|\/commands\//.test(path))
        )).toEqual([])
    } finally {
        rmSync(home, { recursive: true, force: true })
    }
})
