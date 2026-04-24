import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileSyncMock } = vi.hoisted(() => ({
    execFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
    execFileSync: execFileSyncMock
}))

import {
    assertCodexLocalSupported,
    isCodexVersionAtLeast,
    MIN_CODEX_HOOKS_VERSION,
    parseCodexVersion
} from './codexVersion'

describe('codexVersion', () => {
    beforeEach(() => {
        execFileSyncMock.mockReset()
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
            expect(isCodexVersionAtLeast('0.124.0', MIN_CODEX_HOOKS_VERSION)).toBe(true)
        })

        it('accepts newer patch and minor versions', () => {
            expect(isCodexVersionAtLeast('0.124.1', MIN_CODEX_HOOKS_VERSION)).toBe(true)
            expect(isCodexVersionAtLeast('0.125.0', MIN_CODEX_HOOKS_VERSION)).toBe(true)
        })

        it('rejects older versions', () => {
            expect(isCodexVersionAtLeast('0.123.9', MIN_CODEX_HOOKS_VERSION)).toBe(false)
        })
    })

    describe('assertCodexLocalSupported', () => {
        it('passes when codex is new enough', () => {
            execFileSyncMock.mockReturnValueOnce('codex-cli 0.124.0\n')

            expect(() => assertCodexLocalSupported()).not.toThrow()
            expect(execFileSyncMock).toHaveBeenCalledWith('codex', ['--version'], expect.objectContaining({
                encoding: 'utf8'
            }))
        })

        it('fails when codex is too old', () => {
            execFileSyncMock.mockReturnValueOnce('codex-cli 0.123.9\n')

            expect(() => assertCodexLocalSupported()).toThrow(
                'Codex CLI 0.124.0+ is required for hapi codex local mode because HAPI depends on stable hooks. Detected: 0.123.9. Please upgrade Codex and retry.'
            )
        })

        it('fails when the version output cannot be parsed', () => {
            execFileSyncMock.mockReturnValueOnce('codex-cli version unknown\n')

            expect(() => assertCodexLocalSupported()).toThrow(
                'Could not determine Codex CLI version. Codex CLI 0.124.0+ is required for hapi codex local mode because HAPI depends on stable hooks. Please upgrade Codex and retry.'
            )
        })

        it('fails when codex is not available on PATH', () => {
            const error = new Error('spawnSync codex ENOENT') as NodeJS.ErrnoException
            error.code = 'ENOENT'
            execFileSyncMock.mockImplementationOnce(() => {
                throw error
            })

            expect(() => assertCodexLocalSupported()).toThrow(
                'Codex CLI 0.124.0+ is required for hapi codex local mode because HAPI depends on stable hooks. Codex was not found on PATH. Please install or upgrade Codex and retry.'
            )
        })
    })
})
