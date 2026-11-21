import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
    isBunCompiledMock,
    projectPathMock,
} = vi.hoisted(() => ({
    isBunCompiledMock: vi.fn(() => false),
    // A directory that is not a repo checkout: no scripts/tooling helper, no bundled MCP SDK.
    projectPathMock: vi.fn(() => join(tmpdir(), 'hapi-doctor-inline-media-test', 'cli')),
}));

vi.mock('@/projectPath', async () => {
    const actual = await vi.importActual<typeof import('@/projectPath')>('@/projectPath');
    return {
        ...actual,
        isBunCompiled: isBunCompiledMock,
        projectPath: projectPathMock,
    };
});

// `@/configuration` is deliberately left real: it is constructed at import time and other
// modules in this graph (logger, Cursor overlay) depend on it. `fetch` is stubbed instead.

vi.mock('@/persistence', () => ({
    readSettings: vi.fn(async () => ({ cliApiToken: 'test-token' })),
}));

vi.mock('@/api/hubExtraHeaders', () => ({
    buildHubRequestHeaders: () => ({}),
}));

import {
    formatInlineMediaCommand,
    inlineMediaHelperScriptPath,
    runDoctorInlineMedia,
    shellSingleQuote,
} from './doctorInlineMedia'

function stripAnsi(value: string): string {
    // eslint-disable-next-line no-control-regex
    return value.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('doctorInlineMedia', () => {
    afterEach(() => {
        isBunCompiledMock.mockReturnValue(false)
    })

    it('formatInlineMediaCommand uses repo scripts path', () => {
        const script = inlineMediaHelperScriptPath()
        if (script === null) {
            throw new Error('expected a repo checkout path when not running a compiled binary')
        }
        expect(formatInlineMediaCommand(script, '341fe421')).toContain(
            "bun scripts/tooling/hapi-display-image.mjs '341fe421'"
        )
    })

    it('formatInlineMediaCommand shell-quotes paths with spaces and metacharacters', () => {
        const cmd = formatInlineMediaCommand(
            '/tmp/my repo/cli/src/ui/doctorInlineMedia.ts',
            'abc12345',
            '/tmp/my pics/shot.png',
        )
        // scriptPath is cli/src/ui/... → repo root is three levels up (cli).
        // Separators are platform-specific, so assert on the shape instead of a POSIX literal.
        expect(cmd).toMatch(/^cd '.+my repo[\\/]cli' && bun scripts\/tooling\/hapi-display-image\.mjs /)
        expect(cmd).toContain("'abc12345'")
        expect(cmd).toContain("'/tmp/my pics/shot.png'")
    })

    it('shellSingleQuote escapes embedded single quotes for POSIX', () => {
        expect(shellSingleQuote("it's")).toBe(`'it'"'"'s'`)
        expect(shellSingleQuote('$(echo hi)')).toBe("'$(echo hi)'")
    })

    it('has no helper script path in a Bun-compiled install', () => {
        isBunCompiledMock.mockReturnValue(true)
        // Compiled installs resolve projectPath() inside Bun's virtual filesystem, so any path
        // derived from it would be fabricated (e.g. B:\scripts\tooling\... on Windows).
        expect(inlineMediaHelperScriptPath()).toBeNull()
    })
})

describe('runDoctorInlineMedia output', () => {
    const originalSessionId = process.env.HAPI_SESSION_ID
    const originalCliToken = process.env.CLI_API_TOKEN
    let logSpy: ReturnType<typeof vi.spyOn>
    let output: string[]

    function jsonResponse(body: unknown): Response {
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }

    beforeEach(() => {
        output = []
        logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
            output.push(args.map((value) => String(value)).join(' '))
        })
        process.env.HAPI_SESSION_ID = '89ed118d-1111-2222-3333-444455556666'
        delete process.env.CLI_API_TOKEN
        // Hub reachable with no active sessions, so the doctor prints its full report.
        vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
            const url = String(input)
            if (url.includes('/api/auth')) {
                return jsonResponse({ token: 'test-jwt' })
            }
            if (url.includes('/api/sessions')) {
                return jsonResponse({ sessions: [] })
            }
            return new Response(`unexpected request: ${url}`, { status: 404 })
        }))
    })

    afterEach(() => {
        logSpy.mockRestore()
        vi.unstubAllGlobals()
        isBunCompiledMock.mockReturnValue(false)
        if (originalSessionId === undefined) {
            delete process.env.HAPI_SESSION_ID
        } else {
            process.env.HAPI_SESSION_ID = originalSessionId
        }
        if (originalCliToken === undefined) {
            delete process.env.CLI_API_TOKEN
        } else {
            process.env.CLI_API_TOKEN = originalCliToken
        }
    })

    it('reports the repo shell fallback as not applicable in a compiled install instead of a fabricated path', async () => {
        isBunCompiledMock.mockReturnValue(true)

        const code = await runDoctorInlineMedia()
        const text = stripAnsi(output.join('\n'))

        expect(text).toContain('Helper script (repo shell fallback): not applicable (packaged install — use the MCP tools)')
        expect(text).toContain('@modelcontextprotocol/sdk (repo shell fallback): not applicable (packaged install)')
        // Nothing may present a derived (virtual filesystem) path as a usable location.
        expect(text).not.toContain('missing:')
        expect(text).not.toContain('~BUN')
        expect(text).not.toMatch(/[A-Za-z]:\\scripts/)
        expect(text).toContain('2. Shell fallback unavailable (packaged install / no repo checkout) — use MCP tools only')
        expect(code).toBe(0)
    })

    it('still reports a missing helper script when a checkout exists but is incomplete', async () => {
        const code = await runDoctorInlineMedia()
        const text = stripAnsi(output.join('\n'))

        expect(text).toContain('Helper script (repo shell fallback): missing:')
        expect(text).toContain('(optional outside source checkout)')
        expect(text).toContain('@modelcontextprotocol/sdk (repo shell fallback): not found — optional outside source checkout')
        expect(text).toContain('2. Shell fallback unavailable (packaged install / no repo checkout) — use MCP tools only')
        expect(code).toBe(0)
    })
})
