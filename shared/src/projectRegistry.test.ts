import { afterEach, describe, expect, it } from 'bun:test'
import {
    configureGitHubHosts,
    getGitHubUrlForRepo,
    getValidGitHubHosts,
    githubIssueIdentityKey,
    githubPrIdentityKey,
    hostFromGithubPrUrl,
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

    // Review finding (hapi#2147): `.hostname` strips the port, so two GHE
    // instances differing only by port (a real, if unusual, deployment
    // shape) collapsed onto the same identity — linking the second silently
    // replaced the first via upsertExternalRef, and session merges
    // conflated the two. `.host` retains it.
    it('retains a non-default port when extracting the host from a PR/issue URL', () => {
        expect(hostFromGithubPrUrl('https://ghe.example:8443/acme/repo/pull/7')).toBe('ghe.example:8443')
        expect(hostFromGithubPrUrl('https://ghe.example:9443/acme/repo/pull/7')).toBe('ghe.example:9443')
        expect(hostFromGithubPrUrl('https://github.com/acme/repo/pull/7')).toBe('github.com')
    })

    it('keeps identity keys distinct for the same repo#N on different ports of the same host', () => {
        expect(githubPrIdentityKey('acme/repo', 7, 'https://ghe.example:8443/acme/repo/pull/7'))
            .not.toBe(githubPrIdentityKey('acme/repo', 7, 'https://ghe.example:9443/acme/repo/pull/7'))
        expect(githubIssueIdentityKey('acme/repo', 7, 'https://ghe.example:8443/acme/repo/issues/7'))
            .not.toBe(githubIssueIdentityKey('acme/repo', 7, 'https://ghe.example:9443/acme/repo/issues/7'))
    })
})
