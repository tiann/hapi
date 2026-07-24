import { win32 } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveCodexCommandMock, spawnSyncMock } = vi.hoisted(() => ({
    resolveCodexCommandMock: vi.fn(() => ({ command: 'codex', args: [] as string[] })),
    spawnSyncMock: vi.fn()
}))

vi.mock('./codexExecutable', () => ({
    resolveCodexCommand: resolveCodexCommandMock
}))

vi.mock('cross-spawn', () => ({
    default: {
        sync: spawnSyncMock
    }
}))

import {
    assertCodexLocalSupported,
    CODEX_VERSION_TIMEOUT_MS,
    isCodexVersionAtLeast,
    MIN_CODEX_HOOKS_VERSION,
    parseCodexVersion
} from './codexVersion'

const codexScriptPath = win32.join('toolchains', 'nodejs', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')

describe('codexVersion', () => {
    beforeEach(() => {
        resolveCodexCommandMock.mockReset()
        resolveCodexCommandMock.mockReturnValue({ command: 'codex', args: [] as string[] })
        spawnSyncMock.mockReset()
    })

    describe('parseCodexVersion', () => {
        it('extracts the version from codex --version output', () => {
            expect(parseCodexVersion('codex-cli 0.124.0')).toBe('0.124.0')
        })

        it('returns null when the output does not contain a semver', () => {
            expect(parseCodexVersion('codex-cli version unknown')).toBeNull()
        })
    })

    describe('isCodexVersionAtLeast', () => {
        it('accepts the minimum supported version', () => {
            expect(isCodexVersionAtLeast('0.145.0', MIN_CODEX_HOOKS_VERSION)).toBe(true)
        })

        it('accepts newer patch and minor versions', () => {
            expect(isCodexVersionAtLeast('0.145.1', MIN_CODEX_HOOKS_VERSION)).toBe(true)
            expect(isCodexVersionAtLeast('0.146.0', MIN_CODEX_HOOKS_VERSION)).toBe(true)
        })

        it('rejects older versions', () => {
            expect(isCodexVersionAtLeast('0.144.9', MIN_CODEX_HOOKS_VERSION)).toBe(false)
        })
    })

    describe('assertCodexLocalSupported', () => {
        it('checks the resolved Codex command', () => {
            resolveCodexCommandMock.mockReturnValue({
                command: 'node',
                args: [codexScriptPath]
            })
            spawnSyncMock.mockReturnValueOnce({
                status: 0,
                stdout: 'codex-cli 0.145.0\n',
                stderr: ''
            })

            expect(() => assertCodexLocalSupported()).not.toThrow()
            expect(spawnSyncMock).toHaveBeenCalledWith(
                'node',
                [codexScriptPath, '--version'],
                expect.objectContaining({
                    encoding: 'utf8',
                    timeout: CODEX_VERSION_TIMEOUT_MS
                })
            )
        })

        it('passes when codex is new enough', () => {
            spawnSyncMock.mockReturnValueOnce({
                status: 0,
                stdout: 'codex-cli 0.145.0\n',
                stderr: ''
            })

            expect(() => assertCodexLocalSupported()).not.toThrow()
        })

        it('fails when codex is too old', () => {
            spawnSyncMock.mockReturnValueOnce({
                status: 0,
                stdout: 'codex-cli 0.144.9\n',
                stderr: ''
            })

            expect(() => assertCodexLocalSupported()).toThrow(
                'Codex CLI 0.145.0+ is required for hapi codex local mode because HAPI depends on stable hooks. Detected: 0.144.9. Please upgrade Codex and retry.'
            )
        })

        it('fails when the version output cannot be parsed', () => {
            spawnSyncMock.mockReturnValueOnce({
                status: 0,
                stdout: 'codex-cli version unknown\n',
                stderr: ''
            })

            expect(() => assertCodexLocalSupported()).toThrow(
                'Could not determine Codex CLI version. Codex CLI 0.145.0+ is required for hapi codex local mode because HAPI depends on stable hooks. Please upgrade Codex and retry.'
            )
        })

        it('fails when codex is not available on PATH', () => {
            const error = new Error('spawnSync codex ENOENT') as NodeJS.ErrnoException
            error.code = 'ENOENT'
            spawnSyncMock.mockReturnValueOnce({
                status: null,
                stdout: '',
                stderr: '',
                error
            })

            expect(() => assertCodexLocalSupported()).toThrow(
                'Codex CLI 0.145.0+ is required for hapi codex local mode because HAPI depends on stable hooks. Codex was not found on PATH. Please install or upgrade Codex and retry.'
            )
        })

        it('fails when codex version exits unsuccessfully', () => {
            spawnSyncMock.mockReturnValueOnce({
                status: 1,
                stdout: '',
                stderr: 'codex failed'
            })

            expect(() => assertCodexLocalSupported()).toThrow(
                'Could not determine Codex CLI version. codex failed Codex CLI 0.145.0+ is required for hapi codex local mode because HAPI depends on stable hooks. Please upgrade Codex and retry.'
            )
        })
    })
})
