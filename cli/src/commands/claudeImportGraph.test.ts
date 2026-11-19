import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('loads the runner-side Claude runtime without terminal UI or other launchers', () => {
    const home = mkdtempSync(join(tmpdir(), 'hapi-import-graph-'))
    try {
        const snapshot = join(home, 'modules.json')
        execFileSync('bun', ['-e', `
            if (process.stdin.isTTY || process.stdout.isTTY) throw new Error('expected headless stdio')
            const { mock } = await import('bun:test')
            const { writeFileSync } = await import('node:fs')
            const { resolveCommand } = await import('./src/commands/registry')
            const { command, context } = await resolveCommand(['claude', '--started-by', 'runner', '--fork-session'])
            const atResolution = Object.keys(require.cache)
            const control = await import('./src/runner/controlClient')
            mock.module('./src/runner/controlClient', () => ({
                ...control, isRunnerRunningCurrentlyInstalledHappyVersion: async () => true
            }))
            await import('./src/commands/resume')
            mock.module('./src/claude/sdk/query', () => ({
                query({ options }) {
                    if (!options.forkSession) return (async function* () {})()
                    writeFileSync(process.env.SNAPSHOT, JSON.stringify([atResolution, Object.keys(require.cache)]))
                    process.exit(0)
                }
            }))
            process.env.HAPI_CLAUDE_PATH = process.execPath
            await command.run(context)
        `], {
            cwd: fileURLToPath(new URL('../../', import.meta.url)),
            env: { ...process.env, HAPI_HOME: home, SNAPSHOT: snapshot },
            encoding: 'utf8',
            timeout: 15_000,
            maxBuffer: 4 * 1024 * 1024
        })
        const [command, runtime] = (JSON.parse(readFileSync(snapshot, 'utf8')) as string[][])
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

it('imports the headless OpenCode loop without loading its display or local launcher', () => {
    const output = execFileSync('bun', ['-e', `
        await import('./src/opencode/loop')
        console.log(JSON.stringify(Object.keys(require.cache)))
    `], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' })
    const paths = (JSON.parse(output) as string[]).map(path => path.split('\\').join('/'))
    expect(paths.some(path => path.endsWith('/opencode/opencodeRemoteLauncher.ts'))).toBe(true)
    expect(paths.filter(path => /\/node_modules\/(?:react|ink)\/|\/(?:OpencodeDisplay|opencodeLocalLauncher)\./.test(path))).toEqual([])
})
