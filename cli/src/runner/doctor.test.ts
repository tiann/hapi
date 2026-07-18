import { describe, expect, it } from 'vitest'
import {
    createRunnerLaunchAgentSpec,
    detectUnsupportedRunnerTopology,
    sanitizeProcessCommand
} from './doctor'

describe('sanitizeProcessCommand', () => {
    it('redacts runner-spawned payloads from process command lines', () => {
        const command = 'bun src/index.ts codex --started-by runner {"message":"private user text","reply":"private assistant text"}'

        const sanitized = sanitizeProcessCommand(command)

        expect(sanitized).toContain('--started-by runner')
        expect(sanitized).toContain('<redacted>')
        expect(sanitized).not.toContain('private user text')
        expect(sanitized).not.toContain('private assistant text')
    })

    it('truncates long commands by default', () => {
        const command = `hapi codex --model ${'x'.repeat(400)}`

        const sanitized = sanitizeProcessCommand(command, { maxLength: 80 })

        expect(sanitized.length).toBeLessThanOrEqual(130)
        expect(sanitized).toContain('[truncated; use --full-args]')
    })

    it('redacts direct positional prompts instead of printing arbitrary argv tails', () => {
        const command = 'hapi codex secret user request'

        const sanitized = sanitizeProcessCommand(command)

        expect(sanitized).toContain('hapi codex')
        expect(sanitized).toContain('<arg>')
        expect(sanitized).not.toContain('secret')
        expect(sanitized).not.toContain('user request')
    })

    it('redacts multi-word and equals-form sensitive flag values', () => {
        const command = 'hapi codex --prompt secret words here --message=another-secret --model gpt-5.5'

        const sanitized = sanitizeProcessCommand(command)

        expect(sanitized).toContain('--prompt <redacted>')
        expect(sanitized).toContain('--message=<redacted>')
        expect(sanitized).toContain('--model gpt-5.5')
        expect(sanitized).not.toContain('secret words')
        expect(sanitized).not.toContain('another-secret')
    })
})

describe('supported macOS runner LaunchAgent', () => {
    it('builds one direct background start-sync job per canonical HAPI home', () => {
        const first = createRunnerLaunchAgentSpec({
            hapiHome: '/Users/test/.hapi',
            bunPath: '/opt/homebrew/bin/bun',
            cliEntrypoint: '/Users/test/hapi/cli/src/index.ts',
            logPath: '/Users/test/.hapi/logs/runner.log'
        })
        const same = createRunnerLaunchAgentSpec({
            hapiHome: '/Users/test/.hapi/../.hapi',
            bunPath: '/opt/homebrew/bin/bun',
            cliEntrypoint: '/Users/test/hapi/cli/src/index.ts',
            logPath: '/Users/test/.hapi/logs/runner.log'
        })
        const other = createRunnerLaunchAgentSpec({
            hapiHome: '/Users/test/.hapi-alt',
            bunPath: '/opt/homebrew/bin/bun',
            cliEntrypoint: '/Users/test/hapi/cli/src/index.ts',
            logPath: '/Users/test/.hapi-alt/logs/runner.log'
        })

        expect(first.label).toBe(same.label)
        expect(first.label).not.toBe(other.label)
        expect(first.programArguments).toEqual([
            '/opt/homebrew/bin/bun',
            '/Users/test/hapi/cli/src/index.ts',
            'runner',
            'start-sync'
        ])
        expect(first.environmentVariables).toMatchObject({
            HAPI_HOME: '/Users/test/.hapi',
            HAPI_RUNNER_SUPERVISED: 'launchd'
        })
        expect(first.workingDirectory).toBe('/Users/test/hapi/cli')
        expect(first).toMatchObject({
            runAtLoad: true,
            keepAlive: { successfulExit: false },
            throttleInterval: 10,
            processType: 'Background',
            exitTimeOut: 20
        })
    })

    it('reports supervisor scripts, Terminal fallbacks, and monitor loops as unsupported', () => {
        expect(detectUnsupportedRunnerTopology([
            '/bin/zsh /Users/test/bin/hapi-runner-supervisor.sh',
            '/usr/bin/osascript -e tell application "Terminal" to do script "hapi runner start"',
            '/bin/zsh -c while true; do hapi runner status || hapi runner start; sleep 5; done'
        ])).toEqual([
            'supervisor-script',
            'terminal-fallback',
            'monitor-loop'
        ])
    })

    it('ignores unrelated monitors and one-shot Runner status observers', () => {
        expect(detectUnsupportedRunnerTopology([
            'com.tencent.LemonLite.LemonASMonitor',
            '/Applications/Google Chrome --disable-hang-monitor --monitor-self-annotation=ptype=crashpad-handler',
            '/bin/zsh -c hapi runner status > /tmp/runner-status.txt',
            '/bin/zsh -c grep "Runner Supervisor Topology" /tmp/runner-status.txt'
        ])).toEqual([])
    })

    it('classifies legacy HAPI Runner shell and named monitor scripts without generic name matching', () => {
        expect(detectUnsupportedRunnerTopology([
            '/bin/zsh /Users/test/.hapi/bin/run-hapi-runner.sh',
            '/bin/zsh /Users/test/.hapi/bin/hapi-runner-monitor.sh'
        ])).toEqual(['supervisor-script', 'monitor-loop'])
    })
})
