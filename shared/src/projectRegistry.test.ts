import { afterEach, describe, expect, it } from 'bun:test'
import {
    configureGitHubHosts,
    getGitHubUrlForRepo,
    getValidGitHubHosts,
    isValidGitHubHost,
    loadProjectRegistry,
    resetGitHubHostConfiguration
} from './projectRegistry'

afterEach(() => {
    resetGitHubHostConfiguration()
})

describe('projectRegistry hosts', () => {
    it('accepts github.com and *.ghe.com without estate YAML', () => {
        expect(isValidGitHubHost('github.com')).toBe(true)
        expect(isValidGitHubHost('lhs.ghe.com')).toBe(true)
        expect(isValidGitHubHost('acme.ghe.com')).toBe(true)
        expect(isValidGitHubHost('ghe.com')).toBe(false)
        expect(isValidGitHubHost('gitlab.com')).toBe(false)
    })

    it('honors configureGitHubHosts for non-ghe custom hosts', () => {
        expect(isValidGitHubHost('github.example.com')).toBe(false)
        configureGitHubHosts(['github.example.com'])
        expect(isValidGitHubHost('github.example.com')).toBe(true)
        expect(getValidGitHubHosts()).toContain('github.example.com')
    })

    it('builds host-scoped PR URLs', () => {
        expect(getGitHubUrlForRepo('a/b', 1)).toBe('https://github.com/a/b/pull/1')
        expect(getGitHubUrlForRepo('a/b', 1, 'lhs.ghe.com')).toBe('https://lhs.ghe.com/a/b/pull/1')
    })

    it('exposes a browser-safe registry snapshot', () => {
        const registry = loadProjectRegistry()
        expect(registry.settings.default_host).toBe('github.com')
        expect(registry.settings.valid_hosts).toContain('github.com')
        expect(registry.projects.hapi?.targets.length).toBeGreaterThan(0)
    })
})
