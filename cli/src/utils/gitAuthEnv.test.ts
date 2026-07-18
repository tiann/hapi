import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createGitHubAuthEnv } from '../../scripts/gitAuthEnv'

describe('createGitHubAuthEnv', () => {
    it('adds a scoped authorization header without placing credentials in a repository URL', () => {
        const token = 'unit-test-token-value'
        const base = {
            PATH: '/usr/bin',
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'safe.existing',
            GIT_CONFIG_VALUE_0: 'preserved'
        }

        const env = createGitHubAuthEnv(base, token)

        expect(env).not.toBe(base)
        expect(env.GIT_CONFIG_COUNT).toBe('2')
        expect(env.GIT_CONFIG_KEY_0).toBe('safe.existing')
        expect(env.GIT_CONFIG_VALUE_0).toBe('preserved')
        expect(env.GIT_CONFIG_KEY_1).toBe('http.https://github.com/.extraheader')
        expect(env.GIT_CONFIG_VALUE_1).toBe(
            `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
        )
        expect(Object.values(env).some((value) => value?.includes(token) && value.includes('github.com'))).toBe(false)
    })

    it('rejects an invalid inherited Git config count', () => {
        expect(() => createGitHubAuthEnv({ GIT_CONFIG_COUNT: 'not-a-number' }, 'token')).toThrow(
            'GIT_CONFIG_COUNT'
        )
    })
})

it('keeps release Git commands argument-safe and credentials out of repository URLs', async () => {
    const source = await readFile(new URL('../../scripts/update-homebrew-formula.ts', import.meta.url), 'utf8')

    const credentialUrlPrefix = ['https://', 'x-access-token', ':'].join('')
    expect(source).not.toContain(credentialUrlPrefix)
    expect(source).not.toMatch(/\bexecSync\s*\(/)
    expect(source).toContain('execFileSync')
    expect(source).toContain('createGitHubAuthEnv')
})
