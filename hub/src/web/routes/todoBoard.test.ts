import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { BoardItemsResponse, BoardsResponse } from '@hapi/protocol'
import type { WebAppEnv } from '../middleware/auth'
import { createBoardRoutes, fetchAllItemComments, fetchAllProjectItems, GhGraphqlNotFoundError, makeBoardId, parseProjectUrl, parseValidatedItemUrl, PROJECT_QUERY, PROJECT_QUERY_FILTERED, resolveProjectView } from './todoBoard'

const ENV_KEYS = [
    'HAPI_BOARD_HOST',
    'HAPI_BOARD_OWNER',
    'HAPI_BOARD_NUMBER',
    'HAPI_BOARD_STATUS_FIELD',
    'HAPI_BOARD_DONE_VALUES',
    'HAPI_BOARD_LABEL',
    'HAPI_BOARD_ALLOWED_HOSTS'
] as const

// A dev machine actually configured to use this feature plausibly has one or
// more of these set in its shell already — snapshot and clear them once for
// the whole suite, then restore the caller's original values afterward,
// rather than unconditionally deleting them after every test (which would
// permanently wipe a value this process never set in the first place).
const originalEnv = new Map<string, string | undefined>()

beforeAll(() => {
    for (const key of ENV_KEYS) {
        originalEnv.set(key, process.env[key])
        delete process.env[key]
    }
})

afterAll(() => {
    for (const key of ENV_KEYS) {
        const value = originalEnv.get(key)
        if (value === undefined) {
            delete process.env[key]
        } else {
            process.env[key] = value
        }
    }
})

const directories: string[] = []

afterEach(async () => {
    for (const key of ENV_KEYS) {
        delete process.env[key]
    }
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const UNUSED_ACTIONS: Parameters<typeof createBoardRoutes>[4] = {
    close: async () => { throw new Error('close action not mocked for this test') },
    reopen: async () => { throw new Error('reopen action not mocked for this test') },
    comment: async () => { throw new Error('comment action not mocked for this test') },
    setStatus: async () => { throw new Error('setStatus action not mocked for this test') },
    setAssignees: async () => { throw new Error('setAssignees action not mocked for this test') },
    createIssue: async () => { throw new Error('createIssue action not mocked for this test') },
    addItemToProject: async () => { throw new Error('addItemToProject action not mocked for this test') }
}

// Matches whichever board is asking — the safe default for tests that
// exercise close/reopen/comment/status success paths and don't care about
// membership verification specifically (that gets its own dedicated
// describe block). Echoes the target's own owner/number back so it always
// satisfies isMemberOfProject's comparison, regardless of which board/env
// config a given test uses.
const ALWAYS_MEMBER: Parameters<typeof createBoardRoutes>[5] = (target) => ({
    data: { resource: { projectItems: { nodes: [{ project: { number: target.projectNumber, owner: { login: target.ownerLogin } } }] } } }
})

async function createApp(
    runGraphql: Parameters<typeof createBoardRoutes>[1],
    runGraphqlTitle?: Parameters<typeof createBoardRoutes>[2],
    namespace = 'default',
    runGraphqlView?: Parameters<typeof createBoardRoutes>[3],
    actions?: Parameters<typeof createBoardRoutes>[4],
    runGraphqlMembership?: Parameters<typeof createBoardRoutes>[5],
    runGraphqlAssignableUsers?: Parameters<typeof createBoardRoutes>[6],
    runGraphqlIssueTemplateDir?: Parameters<typeof createBoardRoutes>[7],
    runGraphqlComments?: Parameters<typeof createBoardRoutes>[8]
) {
    const dataDir = await mkdtemp(join(tmpdir(), 'hapi-todo-board-'))
    directories.push(dataDir)
    const app = new Hono<WebAppEnv>()
    app.use('*', async (c, next) => {
        c.set('namespace', namespace)
        await next()
    })
    // Default the title/view lookups to 404-shaped responses (not the real
    // `gh` CLI) so items-focused tests that never add a board don't
    // accidentally make a network call just because they didn't pass a mock.
    app.route('/api', createBoardRoutes(
        dataDir,
        runGraphql,
        runGraphqlTitle ?? (() => ({ data: { repositoryOwner: {} } })),
        runGraphqlView ?? (() => ({ data: { repositoryOwner: {} } })),
        actions ?? UNUSED_ACTIONS,
        runGraphqlMembership ?? ALWAYS_MEMBER,
        runGraphqlAssignableUsers ?? (() => ({ data: { repository: { assignableUsers: { nodes: [] } } } })),
        runGraphqlIssueTemplateDir ?? (() => ({ data: { repository: { issueTemplateDir: null } } })),
        runGraphqlComments ?? (() => ({ data: { resource: { comments: { nodes: [] } } } }))
    ))
    return app
}

describe('makeBoardId', () => {
    it('does not collide when a component contains the join separator', () => {
        // host="github.com::evil" + owner="foo" vs. host="github.com" +
        // owner="evil::foo" would naively both join to the same string —
        // percent-encoding each component first prevents that.
        const idA = makeBoardId('github.com::evil', 'foo', 1)
        const idB = makeBoardId('github.com', 'evil::foo', 1)
        expect(idA).not.toBe(idB)
    })

    it('still produces the plain, readable id for normal inputs', () => {
        expect(makeBoardId('github.com', 'heavygee', 6)).toBe('github.com::heavygee::6')
    })

    it('appends a distinct view segment so the project and a view onto it can both be stored', () => {
        const plainId = makeBoardId('github.com', 'heavygee', 6)
        const viewId = makeBoardId('github.com', 'heavygee', 6, 8)
        expect(viewId).not.toBe(plainId)
        expect(viewId).toBe('github.com::heavygee::6::view::8')
    })

    it('normalizes host and owner casing — GitHub hostnames and owner logins are case-insensitive (Codex review)', () => {
        expect(makeBoardId('GitHub.com', 'HeavyGee', 6)).toBe(makeBoardId('github.com', 'heavygee', 6))
        expect(makeBoardId('GitHub.com', 'HeavyGee', 6)).toBe('github.com::heavygee::6')
    })
})

describe('parseProjectUrl', () => {
    it('parses a github.com user project URL', () => {
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/6')).toEqual({
            host: 'github.com', ownerLogin: 'heavygee', projectNumber: 6
        })
    })

    it('parses an org project URL, a trailing slash, and a bare host (no scheme)', () => {
        expect(parseProjectUrl('https://github.com/orgs/acme/projects/42/')).toEqual({
            host: 'github.com', ownerLogin: 'acme', projectNumber: 42
        })
        expect(parseProjectUrl('github.com/users/heavygee/projects/6')).toEqual({
            host: 'github.com', ownerLogin: 'heavygee', projectNumber: 6
        })
    })

    it('parses a GHE host', () => {
        expect(parseProjectUrl('https://lhs.ghe.com/orgs/lockhouse/projects/3')).toEqual({
            host: 'lhs.ghe.com', ownerLogin: 'lockhouse', projectNumber: 3
        })
    })

    it('parses a trailing /views/<n> as a restrictive view onto the same project', () => {
        expect(parseProjectUrl('https://lhs.ghe.com/orgs/lockhouse/projects/3/views/8')).toEqual({
            host: 'lhs.ghe.com', ownerLogin: 'lockhouse', projectNumber: 3, viewNumber: 8
        })
    })

    it('parses a view URL with a trailing slash or query/hash', () => {
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/6/views/1/')).toEqual({
            host: 'github.com', ownerLogin: 'heavygee', projectNumber: 6, viewNumber: 1
        })
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/6/views/1?pane=info')).toEqual({
            host: 'github.com', ownerLogin: 'heavygee', projectNumber: 6, viewNumber: 1
        })
    })

    it('rejects an invalid view number the same way it rejects an invalid project number', () => {
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/6/views/0')).toBeNull()
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/6/views/not-a-number')).toBeNull()
    })

    it('does not mistake an unrelated trailing path that merely starts with "views" for a view segment', () => {
        // The "/views" rejection must be boundary-aware — otherwise a
        // trailing path like "/viewsomething" (which happens to start with
        // the same five letters) would be wrongly rejected as a malformed
        // view segment instead of accepted as ordinary trailing junk.
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/6/viewsomething')).toEqual({
            host: 'github.com', ownerLogin: 'heavygee', projectNumber: 6
        })
    })

    it('rejects anything that is not a recognizable Projects v2 URL', () => {
        expect(parseProjectUrl('https://github.com/heavygee/hapi')).toBeNull()
        expect(parseProjectUrl('not a url at all')).toBeNull()
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/not-a-number')).toBeNull()
    })

    it('rejects a project number that is not a valid GraphQL Int', () => {
        // $number: Int! is a non-fractional signed 32-bit value — anything
        // else always fails the subsequent gh api call, so reject it here.
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/1.5')).toBeNull()
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/0')).toBeNull()
        expect(parseProjectUrl('https://github.com/users/heavygee/projects/99999999999')).toBeNull()
    })
})

describe('owner-only namespace restriction', () => {
    it('rejects every board route for a non-default namespace', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'some-other-namespace')

        const list = await app.request('/api/todo-boards')
        expect(list.status).toBe(403)

        const add = await app.request('/api/todo-boards', { method: 'POST', body: JSON.stringify({ url: 'https://github.com/users/heavygee/projects/6' }) })
        expect(add.status).toBe(403)

        const del = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6', { method: 'DELETE' })
        expect(del.status).toBe(403)

        const items = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(items.status).toBe(403)
    })
})

describe('GET /api/todo-boards', () => {
    it('returns an empty list when genuinely unconfigured — no silent demo-board default (hapi#238)', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards')
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ boards: [] })
    })

    it('reads the board from env when configured', async () => {
        process.env.HAPI_BOARD_OWNER = 'acme'
        process.env.HAPI_BOARD_NUMBER = '42'
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards')
        expect(await response.json()).toEqual({ boards: [{ id: 'github.com::acme::42', label: 'acme/42' }] })
    })

    it('treats a non-numeric board number with no owner set as unconfigured — never invents an owner/project (hapi#238)', async () => {
        process.env.HAPI_BOARD_NUMBER = 'not-a-number'
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards')
        expect(await response.json()).toEqual({ boards: [] })
    })

    it('treats a fractional board number with no owner set as unconfigured — never invents an owner/project (hapi#238)', async () => {
        process.env.HAPI_BOARD_NUMBER = '1.5'
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards')
        expect(await response.json()).toEqual({ boards: [] })
    })

    it('treats an owner with no valid number as unconfigured — a partial HAPI_BOARD_* set must never fall back to a hardcoded owner/project (hapi#238)', async () => {
        // Regression guard: this used to silently fall back to a hardcoded
        // heavygee/6 board for *any* missing field, so an operator who set
        // only HAPI_BOARD_OWNER (or mistyped HAPI_BOARD_NUMBER) would
        // unknowingly load someone else's project. Owner and number must
        // both be valid together, or there is no env-seeded board at all.
        process.env.HAPI_BOARD_OWNER = 'acme'
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards')
        expect(await response.json()).toEqual({ boards: [] })
    })
})

describe('POST /api/todo-boards', () => {
    it('rejects a missing or unparsable url', async () => {
        const app = await createApp(() => ({ data: {} }))
        const missing = await app.request('/api/todo-boards', { method: 'POST', body: JSON.stringify({}) })
        expect(missing.status).toBe(400)
        const bad = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'not a project url' })
        })
        expect(bad.status).toBe(400)
    })

    it('rejects a non-string url with 400, not a 500 from an uncaught TypeError', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 123 })
        })
        expect(response.status).toBe(400)
    })

    it('404s when the project does not resolve', async () => {
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: {} } }))
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/users/nobody/projects/1' })
        })
        expect(response.status).toBe(404)
    })

    it('rejects a board host outside the default allowlist (github.com only)', async () => {
        // A POST-supplied host reaches `gh api --hostname <host>`, which
        // resolves that host's credentials (including any enterprise
        // token) — without an allowlist, an attacker-controlled host in
        // the URL could make the hub leak its own token to it.
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'x' } } } }))
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://attacker.example/orgs/acme/projects/9' })
        })
        expect(response.status).toBe(400)
    })

    it('allows an explicitly-configured host via HAPI_BOARD_ALLOWED_HOSTS', async () => {
        process.env.HAPI_BOARD_ALLOWED_HOSTS = 'github.com,lhs.ghe.com'
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'Lockhouse TODO' } } } }))
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://lhs.ghe.com/orgs/lockhouse/projects/3' })
        })
        expect(response.status).toBe(200)
    })

    it('adds a board to a genuinely empty list, using the project title as the label', async () => {
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }))
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        expect(response.status).toBe(200)
        const body = await response.json() as BoardsResponse
        expect(body.boards).toEqual([
            { id: 'github.com::acme::9', label: 'Acme Roadmap' }
        ])
    })

    it('adds a board, keeping the env-configured one in the list (add, not replace)', async () => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }))
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        expect(response.status).toBe(200)
        const body = await response.json() as BoardsResponse
        expect(body.boards).toEqual([
            { id: 'github.com::heavygee::6', label: 'heavygee/6' },
            { id: 'github.com::acme::9', label: 'Acme Roadmap' }
        ])
    })

    it('adds a view-scoped board as a distinct board, labeled with the view name', async () => {
        const app = await createApp(
            () => ({ data: {} }),
            () => { throw new Error('should not use the plain title lookup for a view URL') },
            'default',
            () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: { name: 'Sprint board' } } } } })
        )
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9/views/8' })
        })
        expect(response.status).toBe(200)
        const body = await response.json() as BoardsResponse
        expect(body.boards).toEqual([
            { id: 'github.com::acme::9::view::8', label: 'Acme Roadmap · Sprint board' }
        ])
    })

    it('falls back to a generic "View N" label when the view has no name', async () => {
        const app = await createApp(
            () => ({ data: {} }),
            undefined,
            'default',
            () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: {} } } } })
        )
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9/views/8' })
        })
        const body = await response.json() as BoardsResponse
        expect(body.boards.find(b => b.id === 'github.com::acme::9::view::8')?.label).toBe('Acme Roadmap · View 8')
    })

    it('404s when the view number does not exist on the project', async () => {
        const app = await createApp(
            () => ({ data: {} }),
            undefined,
            'default',
            () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: null } } } })
        )
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9/views/999' })
        })
        expect(response.status).toBe(404)
    })

    it('allows adding both the plain project and a view onto it, as two separate boards', async () => {
        const app = await createApp(
            () => ({ data: {} }),
            () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }),
            'default',
            () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: { name: 'Sprint board' } } } } })
        )
        await app.request('/api/todo-boards', { method: 'POST', body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' }) })
        const response = await app.request('/api/todo-boards', { method: 'POST', body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9/views/8' }) })
        const body = await response.json() as BoardsResponse
        expect(body.boards.map(b => b.id)).toEqual(['github.com::acme::9', 'github.com::acme::9::view::8'])
    })

    it('validates via the lightweight title-only query, never the full items query', async () => {
        const itemsQuery = () => { throw new Error('should not call the heavy items query to add a board') }
        const app = await createApp(itemsQuery, () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }))
        const response = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        expect(response.status).toBe(200)
    })

    it('is idempotent for the same board added twice', async () => {
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }))
        await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        const second = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        const body = await second.json() as BoardsResponse
        expect(body.boards).toHaveLength(1)
    })

    it('is idempotent across different casing of the same host/owner (Codex review)', async () => {
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }))
        await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        const second = await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://GitHub.com/orgs/Acme/projects/9' })
        })
        const body = await second.json() as BoardsResponse
        expect(body.boards).toHaveLength(1)
    })
})

describe('DELETE /api/todo-boards/:id', () => {
    it('removes one board, keeping the rest of the list', async () => {
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }))
        await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/other/projects/1' })
        })
        const response = await app.request('/api/todo-boards/github.com%3A%3Aacme%3A%3A9', { method: 'DELETE' })
        const body = await response.json() as BoardsResponse
        expect(body.boards).toEqual([{ id: 'github.com::other::1', label: 'Acme Roadmap' }])
    })

    it('removing the last board leaves the list genuinely empty when nothing is env-configured (hapi#238)', async () => {
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }))
        await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        const response = await app.request('/api/todo-boards/github.com%3A%3Aacme%3A%3A9', { method: 'DELETE' })
        const body = await response.json() as BoardsResponse
        expect(body.boards).toEqual([])
    })

    it('removing the last board re-seeds the env-configured default instead of leaving it empty, when one is actually set', async () => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
        const app = await createApp(() => ({ data: {} }), () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }))
        await app.request('/api/todo-boards', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9' })
        })
        const response = await app.request('/api/todo-boards/github.com%3A%3Aacme%3A%3A9', { method: 'DELETE' })
        const body = await response.json() as BoardsResponse
        expect(body.boards).toEqual([{ id: 'github.com::heavygee::6', label: 'heavygee/6' }])
    })

    it('is a no-op for an id that does not exist', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards/unknown', { method: 'DELETE' })
        const body = await response.json() as BoardsResponse
        expect(body.boards).toEqual([])
    })
})

describe('parseValidatedItemUrl', () => {
    const board = { host: 'github.com' }

    it('accepts a well-formed issue URL on the board\'s own host', () => {
        expect(parseValidatedItemUrl('https://github.com/acme/widgets/issues/12', board)).toEqual({
            url: 'https://github.com/acme/widgets/issues/12',
            isPullRequest: false,
            owner: 'acme',
            repo: 'widgets'
        })
    })

    it('accepts a well-formed pull-request URL', () => {
        expect(parseValidatedItemUrl('https://github.com/acme/widgets/pull/9', board)).toEqual({
            url: 'https://github.com/acme/widgets/pull/9',
            isPullRequest: true,
            owner: 'acme',
            repo: 'widgets'
        })
    })

    it('rejects a URL on a different host — the SSRF-class case', () => {
        // The whole point of this check: a JWT caller supplying this URL
        // must not make the hub shell out `gh issue close` against an
        // arbitrary attacker-controlled host. GH_HOST does not protect
        // against this — gh dials the URL's own embedded host regardless —
        // so this check is the sole defense, not defense-in-depth.
        expect(parseValidatedItemUrl('https://attacker.example/acme/widgets/issues/12', board)).toBeNull()
    })

    it('rejects a non-https scheme even on the right host/path', () => {
        expect(parseValidatedItemUrl('http://github.com/acme/widgets/issues/12', board)).toBeNull()
        expect(parseValidatedItemUrl('file://github.com/acme/widgets/issues/12', board)).toBeNull()
    })

    it('matches host case-insensitively, normalizing the host in the rebuilt URL', () => {
        expect(parseValidatedItemUrl('https://GitHub.com/acme/widgets/issues/12', board)).toEqual({
            url: 'https://github.com/acme/widgets/issues/12',
            isPullRequest: false,
            owner: 'acme',
            repo: 'widgets'
        })
    })

    it('rebuilds a canonical URL rather than passing the raw input through', () => {
        // Trailing slash and query/fragment noise must not survive into the
        // string handed to `gh` — it's rebuilt from validated path parts.
        expect(parseValidatedItemUrl('https://github.com/acme/widgets/issues/12/?foo=bar#x', board)).toEqual({
            url: 'https://github.com/acme/widgets/issues/12',
            isPullRequest: false,
            owner: 'acme',
            repo: 'widgets'
        })
    })

    it('rejects a non-issue, non-pull path on the right host', () => {
        expect(parseValidatedItemUrl('https://github.com/acme/widgets', board)).toBeNull()
        expect(parseValidatedItemUrl('https://github.com/acme/widgets/discussions/1', board)).toBeNull()
    })

    it('rejects a malformed URL instead of throwing', () => {
        expect(parseValidatedItemUrl('not a url', board)).toBeNull()
    })

    it('preserves a non-default port — a GHE board on a custom port must not reject every write (Codex review)', () => {
        const portedBoard = { host: 'ghe.example:8443' }
        expect(parseValidatedItemUrl('https://ghe.example:8443/acme/widgets/issues/12', portedBoard)).toEqual({
            url: 'https://ghe.example:8443/acme/widgets/issues/12',
            isPullRequest: false,
            owner: 'acme',
            repo: 'widgets'
        })
        // Same hostname, different (or default/missing) port must still be rejected.
        expect(parseValidatedItemUrl('https://ghe.example/acme/widgets/issues/12', portedBoard)).toBeNull()
        expect(parseValidatedItemUrl('https://ghe.example:9999/acme/widgets/issues/12', portedBoard)).toBeNull()
    })

    it('normalizes an explicit default HTTPS port before comparing hosts (Codex review)', () => {
        // A board added from a URL that explicitly includes :443 stores
        // board.host verbatim as "ghe.example:443" (parseProjectUrl's regex
        // doesn't normalize), but WHATWG URL.host always strips an explicit
        // default port — so an item URL on that same host never carries
        // :443 once parsed, and the two sides never matched without this fix.
        const explicitDefaultPortBoard = { host: 'ghe.example:443' }
        expect(parseValidatedItemUrl('https://ghe.example/acme/widgets/issues/12', explicitDefaultPortBoard)).toEqual({
            url: 'https://ghe.example/acme/widgets/issues/12',
            isPullRequest: false,
            owner: 'acme',
            repo: 'widgets'
        })
        expect(parseValidatedItemUrl('https://ghe.example:443/acme/widgets/issues/12', explicitDefaultPortBoard)).toEqual({
            url: 'https://ghe.example/acme/widgets/issues/12',
            isPullRequest: false,
            owner: 'acme',
            repo: 'widgets'
        })
        // A genuinely different host must still be rejected.
        expect(parseValidatedItemUrl('https://attacker.example/acme/widgets/issues/12', explicitDefaultPortBoard)).toBeNull()
    })
})

describe('resolveProjectView', () => {
    it('returns the title, view name, and trimmed filter on success', () => {
        const result = resolveProjectView({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: { name: 'Sprint board', filter: ' status:"Done" ' } } } } }, 8)
        expect(result).toEqual({ ok: true, title: 'Acme Roadmap', viewName: 'Sprint board', itemsFilter: 'status:"Done"' })
    })

    it('treats an empty or whitespace-only filter the same as no filter', () => {
        expect(resolveProjectView({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: { filter: '' } } } } }, 8)).toMatchObject({ ok: true, itemsFilter: undefined })
        expect(resolveProjectView({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: { filter: '   ' } } } } }, 8)).toMatchObject({ ok: true, itemsFilter: undefined })
        expect(resolveProjectView({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: { filter: null } } } } }, 8)).toMatchObject({ ok: true, itemsFilter: undefined })
    })

    it('fails distinctly for a missing project vs. a missing view, both as "not found"', () => {
        const missingProject = resolveProjectView({ data: { repositoryOwner: {} } }, 8)
        expect(missingProject).toEqual({ ok: false, error: 'Project not found, or not accessible with the current gh auth' })

        const missingView = resolveProjectView({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: null } } } }, 8)
        expect(missingView).toEqual({ ok: false, error: 'View 8 not found on this project' })
    })

    it('surfaces top-level GraphQL errors without a "not found" message', () => {
        const result = resolveProjectView({ errors: [{ message: 'Could not resolve to a ProjectV2Owner' }] }, 8)
        expect(result).toEqual({ ok: false, error: 'Could not resolve to a ProjectV2Owner' })
    })
})

describe('fetchAllProjectItems (operator-reported dogfood bug: #431 missing after manual refresh)', () => {
    // Lockhouse Work has well over 100 items — items(first: 100) with no
    // pagination silently dropped everything past page 1, so a card moved
    // into a tracked status (or any item past that boundary) never appeared
    // no matter how many times "refresh" was pressed, since refresh re-ran
    // the exact same first-100 query rather than a real re-fetch of the
    // whole board.
    function page(nodeIds: string[], hasNextPage: boolean, endCursor: string | null = null): string {
        return JSON.stringify({
            data: {
                repositoryOwner: {
                    projectV2: {
                        title: 'Lockhouse Work',
                        items: {
                            nodes: nodeIds.map(id => ({ id, content: null })),
                            pageInfo: { hasNextPage, endCursor }
                        }
                    }
                }
            }
        })
    }

    it('returns a single page unchanged when there is nothing more to fetch', async () => {
        const execPage = async () => page(['a', 'b'], false)
        const result = await fetchAllProjectItems(execPage)
        expect(result.data?.repositoryOwner?.projectV2?.items?.nodes).toEqual([{ id: 'a', content: null }, { id: 'b', content: null }])
    })

    it('follows pageInfo.endCursor across pages and merges every item into one list', async () => {
        const calls: Array<string | undefined> = []
        const execPage = async (after: string | undefined) => {
            calls.push(after)
            if (after === undefined) return page(['a', 'b'], true, 'cursor-1')
            if (after === 'cursor-1') return page(['c'], true, 'cursor-2')
            return page(['d'], false)
        }
        const result = await fetchAllProjectItems(execPage)
        expect(result.data?.repositoryOwner?.projectV2?.items?.nodes).toEqual([{ id: 'a', content: null }, { id: 'b', content: null }, { id: 'c', content: null }, { id: 'd', content: null }])
        expect(calls).toEqual([undefined, 'cursor-1', 'cursor-2'])
    })

    it('stops at the page cap instead of looping forever on a pathological board', async () => {
        let calls = 0
        const execPage = async () => {
            calls += 1
            return page([`item-${calls}`], true, `cursor-${calls}`)
        }
        const result = await fetchAllProjectItems(execPage)
        expect(calls).toBe(20)
        expect(result.data?.repositoryOwner?.projectV2?.items?.nodes?.length).toBe(20)
    })

    it('returns top-level errors from the first page immediately, without paginating further', async () => {
        let calls = 0
        const execPage = async () => {
            calls += 1
            return JSON.stringify({ errors: [{ message: 'Could not resolve to a ProjectV2Owner' }] })
        }
        const result = await fetchAllProjectItems(execPage)
        expect(result.errors).toEqual([{ message: 'Could not resolve to a ProjectV2Owner' }])
        expect(calls).toBe(1)
    })

    it('returns errors surfaced on a later page without silently dropping them', async () => {
        const execPage = async (after: string | undefined) => {
            if (after === undefined) return page(['a'], true, 'cursor-1')
            return JSON.stringify({ errors: [{ message: 'rate limited' }] })
        }
        const result = await fetchAllProjectItems(execPage)
        expect(result.errors).toEqual([{ message: 'rate limited' }])
    })
})

// "Every status/column is shown" was never a stated requirement for this
// feature (confirmed against the original design doc and hapi#235's own
// scope — both require status to be the grouping axis, shown verbatim, with
// done items folded to the bottom rather than removed; neither says
// anything about completeness across statuses). The behavior itself is real
// and already covered by BoardList.test.ts (web) and the item-mapping test
// above (hub) proving items of every status survive the response. What
// neither of those tests covers is the *request* itself — operator ruling:
// lock in, at the query-construction level, that the plain/unfiltered board
// path never asks GitHub for a subset of items in the first place.
describe('PROJECT_QUERY (unfiltered board path sends no item/status predicate)', () => {
    it('does not include an items query/filter argument', () => {
        expect(PROJECT_QUERY).not.toMatch(/items\([^)]*query:/)
        expect(PROJECT_QUERY).not.toContain('itemsFilter')
    })

    it('contrasts with PROJECT_QUERY_FILTERED, which deliberately does carry one — proving the assertion above is actually meaningful, not just an accident of unrelated wording', () => {
        expect(PROJECT_QUERY_FILTERED).toMatch(/items\([^)]*query:\s*\$itemsFilter/)
        expect(PROJECT_QUERY_FILTERED).toContain('itemsFilter')
    })
})

describe('fetchAllItemComments (Codex review, hapi#238: comments(last: 100) silently dropped older comments)', () => {
    function page(ids: string[], hasNextPage: boolean, endCursor: string | null = null): string {
        const comments = { nodes: ids.map(id => ({ id })), pageInfo: { hasNextPage, endCursor } }
        return JSON.stringify({ data: { resource: { comments } } })
    }

    it('returns a single page unchanged when there is nothing more to fetch', async () => {
        const execPage = async () => page(['a', 'b'], false)
        const result = await fetchAllItemComments(execPage)
        expect(result.data?.resource?.comments?.nodes?.map(n => n?.id)).toEqual(['a', 'b'])
    })

    it('follows pageInfo.endCursor across pages and merges every comment into one list, oldest first', async () => {
        const calls: Array<string | undefined> = []
        const execPage = async (after: string | undefined) => {
            calls.push(after)
            if (after === undefined) return page(['a', 'b'], true, 'cursor-1')
            if (after === 'cursor-1') return page(['c'], true, 'cursor-2')
            return page(['d'], false)
        }
        const result = await fetchAllItemComments(execPage)
        expect(result.data?.resource?.comments?.nodes?.map(n => n?.id)).toEqual(['a', 'b', 'c', 'd'])
        expect(calls).toEqual([undefined, 'cursor-1', 'cursor-2'])
    })

    it('stops at the page cap instead of looping forever on a pathological thread', async () => {
        let calls = 0
        const execPage = async () => {
            calls += 1
            return page([`comment-${calls}`], true, `cursor-${calls}`)
        }
        const result = await fetchAllItemComments(execPage)
        expect(calls).toBe(10)
        expect(result.data?.resource?.comments?.nodes?.length).toBe(10)
    })

    it('returns top-level errors from the first page immediately, without paginating further', async () => {
        let calls = 0
        const execPage = async () => {
            calls += 1
            return JSON.stringify({ errors: [{ message: 'Could not resolve to a ProjectItem' }] })
        }
        const result = await fetchAllItemComments(execPage)
        expect(result.errors).toEqual([{ message: 'Could not resolve to a ProjectItem' }])
        expect(calls).toBe(1)
    })

    it('returns errors surfaced on a later page without silently dropping them', async () => {
        const execPage = async (after: string | undefined) => {
            if (after === undefined) return page(['a'], true, 'cursor-1')
            return JSON.stringify({ errors: [{ message: 'rate limited' }] })
        }
        const result = await fetchAllItemComments(execPage)
        expect(result.errors).toEqual([{ message: 'rate limited' }])
    })
})

describe('GET /api/todo-boards/:id/items', () => {
    // Every test below targets the default heavygee/6 board by id without
    // adding it via POST first — env-configure it explicitly (hapi#238: an
    // unconfigured board list is now genuinely empty, not the hardcoded demo
    // board, so these tests must opt in instead of relying on the old
    // silent default).
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('404s for an unknown board id', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards/unknown/items')
        expect(response.status).toBe(404)
    })

    it('maps gh graphql items, status order, done values, body, and the richer item fields', async () => {
        const app = await createApp(() => ({
            data: {
                repositoryOwner: {
                    projectV2: {
                        field: { options: [{ name: 'Todo' }, { name: 'In Progress' }, { name: 'Done' }] },
                        items: {
                            nodes: [
                                {
                                    id: 'item-1',
                                    content: {
                                        __typename: 'Issue',
                                        title: 'Fix the thing',
                                        number: 12,
                                        url: 'https://github.com/acme/widgets/issues/12',
                                        state: 'OPEN',
                                        updatedAt: '2026-10-06T12:00:00Z',
                                        createdAt: '2026-10-01T09:00:00Z',
                                        closedAt: null,
                                        body: 'Some **markdown** body.',
                                        repository: { nameWithOwner: 'acme/widgets' },
                                        author: { login: 'octocat', avatarUrl: 'https://example.com/octocat.png' },
                                        assignees: { nodes: [{ login: 'hubot', avatarUrl: 'https://example.com/hubot.png' }, null] },
                                        labels: { nodes: [{ name: 'bug', color: 'ff0000' }, null] },
                                        milestone: { title: 'v1.0', dueOn: '2026-12-01' }
                                    },
                                    fieldValueByName: { name: 'In Progress' },
                                    fieldValues: {
                                        nodes: [
                                            { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'In Progress', field: { name: 'Status' } },
                                            { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'High', field: { name: 'Priority' } },
                                            { __typename: 'ProjectV2ItemFieldNumberValue', number: 3, field: { name: 'Points' } },
                                            { __typename: 'ProjectV2ItemFieldTextValue', text: '', field: { name: 'Empty text field' } },
                                            null
                                        ]
                                    }
                                },
                                {
                                    id: 'item-2',
                                    content: { __typename: 'DraftIssue', title: 'Untracked idea' },
                                    fieldValueByName: null
                                }
                            ]
                        }
                    }
                }
            }
        }))

        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(response.status).toBe(200)
        const body = await response.json() as BoardItemsResponse
        expect(body.board).toEqual({ id: 'github.com::heavygee::6', label: 'heavygee/6' })
        expect(body.statusOrder).toEqual(['Todo', 'In Progress', 'Done'])
        expect(body.doneValues).toEqual(['Done'])
        expect(body.items).toEqual([
            {
                id: 'item-1',
                title: 'Fix the thing',
                url: 'https://github.com/acme/widgets/issues/12',
                number: 12,
                repo: 'acme/widgets',
                state: 'OPEN',
                status: 'In Progress',
                updatedAt: '2026-10-06T12:00:00Z',
                createdAt: '2026-10-01T09:00:00Z',
                closedAt: null,
                body: 'Some **markdown** body.',
                isPullRequest: false,
                author: { login: 'octocat', avatarUrl: 'https://example.com/octocat.png' },
                assignees: [{ login: 'hubot', avatarUrl: 'https://example.com/hubot.png' }],
                labels: [{ name: 'bug', color: 'ff0000' }],
                milestone: { title: 'v1.0', dueOn: '2026-12-01' },
                // Status is excluded (already surfaced via `status`); the
                // empty-string text value is excluded as not worth rendering.
                customFields: [
                    { name: 'Priority', value: 'High' },
                    { name: 'Points', value: '3' }
                ]
            },
            {
                id: 'item-2',
                title: 'Untracked idea',
                url: null,
                number: null,
                repo: null,
                state: null,
                status: null,
                updatedAt: null,
                createdAt: null,
                closedAt: null,
                body: null,
                isPullRequest: false,
                author: null,
                assignees: [],
                labels: [],
                milestone: null,
                customFields: []
            }
        ])
    })

    it('marks a PullRequest item as isPullRequest', async () => {
        const app = await createApp(() => ({
            data: {
                repositoryOwner: {
                    projectV2: {
                        field: { options: [] },
                        items: { nodes: [{ id: 'item-pr', content: { __typename: 'PullRequest', title: 'Bump deps', url: 'https://github.com/acme/widgets/pull/9' }, fieldValueByName: null }] }
                    }
                }
            }
        }))
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        const body = await response.json() as BoardItemsResponse
        expect(body.items[0]?.isPullRequest).toBe(true)
    })

    it('applies HAPI_BOARD_DONE_VALUES as a comma-separated override', async () => {
        process.env.HAPI_BOARD_DONE_VALUES = 'Done, Archived'
        const app = await createApp(() => ({ data: { repositoryOwner: { projectV2: { field: { options: [] }, items: { nodes: [] } } } } }))
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        const body = await response.json() as BoardItemsResponse
        expect(body.doneValues).toEqual(['Done', 'Archived'])
    })

    it('surfaces gh CLI failures as a 502 with the error message', async () => {
        const app = await createApp(() => {
            throw new Error('gh CLI not available: spawn gh ENOENT')
        })
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'gh CLI not available: spawn gh ENOENT' })
    })

    it('surfaces gh graphql errors array as a 502', async () => {
        const app = await createApp(() => ({ errors: [{ message: 'Could not resolve to a ProjectV2Owner' }] }))
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'Could not resolve to a ProjectV2Owner' })
    })

    it('404s when the configured project is missing or inaccessible (no top-level error)', async () => {
        // GitHub can return `projectV2: null` without a top-level GraphQL
        // error (owner exists, project number doesn't or isn't visible) —
        // without this check the route would 200 with an empty board.
        const app = await createApp(() => ({ data: { repositoryOwner: {} } }))
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(response.status).toBe(404)
    })

    it('502s when the configured status field name does not exist at all (field: null)', async () => {
        const app = await createApp(() => ({ data: { repositoryOwner: { projectV2: { field: null, items: { nodes: [] } } } } }))
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(response.status).toBe(502)
    })

    it('502s when the configured status field exists but is not a single-select (field: {})', async () => {
        // The inline fragment `... on ProjectV2SingleSelectField { options { name } }`
        // only contributes `options` when the concrete type matches — a
        // same-named field of a different type comes back as a truthy empty
        // object, not null.
        const app = await createApp(() => ({ data: { repositoryOwner: { projectV2: { field: {}, items: { nodes: [] } } } } }))
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(response.status).toBe(502)
    })

    it('skips a null entry in the items nodes array instead of throwing', async () => {
        const app = await createApp(() => ({
            data: {
                repositoryOwner: {
                    projectV2: {
                        field: { options: [{ name: 'Done' }] },
                        items: { nodes: [null, { id: 'item-1', content: { __typename: 'DraftIssue', title: 'Still here' } }] }
                    }
                }
            }
        }))
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(response.status).toBe(200)
        const body = await response.json() as BoardItemsResponse
        expect(body.items).toHaveLength(1)
        expect(body.items[0]?.title).toBe('Still here')
    })

    it('maps a "not found" error from a view-scoped board\'s filter resolution to 404, not 502', async () => {
        // Simulates what the real runGhGraphql throws (via resolveProjectView)
        // when a stored view-scoped board's view or project has since been
        // deleted/renamed/access-revoked — should 404 the same way the
        // plain-project "projectV2: null" case does above, not fall through
        // to the generic 502 catch-all (which the existing "gh CLI not
        // available" test above already covers for non-"not found" errors).
        const app = await createApp(() => { throw new Error('View 8 not found on this project') })
        const response = await app.request('/api/todo-boards/github.com%3A%3Aheavygee%3A%3A6/items')
        expect(response.status).toBe(404)
    })
})

const DEFAULT_BOARD_ID = 'github.com::heavygee::6'
const VALID_ITEM_URL = 'https://github.com/heavygee/hapi-demo-board/issues/1'

// Shared by every write route via requireBoardAndValidUrl — exercised once
// here through `close` rather than duplicated across all four routes.
describe('write-target project membership verification', () => {
    // Most tests below target DEFAULT_BOARD_ID directly without adding it
    // via POST first (hapi#238: see the beforeEach doc comment in the
    // "GET .../items" describe block above for why this is needed now).
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('rejects a same-host, well-formed URL that is not actually on this board\'s project', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, () => ({
            data: { resource: { projectItems: { nodes: [] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(400)
    })

    it('rejects when the URL is on a different project under the same owner', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, () => ({
            data: { resource: { projectItems: { nodes: [{ project: { number: 999, owner: { login: 'heavygee' } } }] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(400)
    })

    it('allows the write when the membership check confirms the item is on this project', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            close: async (target, comment) => { calls.push([target, comment]) }
        }, () => ({
            data: { resource: { projectItems: { nodes: [{ project: { number: 6, owner: { login: 'heavygee' } } }] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(200)
        expect(calls).toHaveLength(1)
    })

    it('matches the owner login case-insensitively', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            close: async () => {}
        }, () => ({
            data: { resource: { projectItems: { nodes: [{ project: { number: 6, owner: { login: 'HeavyGee' } } }] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(200)
    })

    it('surfaces a failed membership lookup as a 502, not a silent pass-through', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, () => {
            throw new Error('gh api graphql failed: rate limited')
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(502)
    })

    it('surfaces a GraphQL-level error in a parseable membership response as a 502, not a misleading 400 (Codex review)', async () => {
        // A partial-data response (scope/resolver failure) can still parse
        // fine while carrying an `errors` array and an empty `projectItems` —
        // that must not read identically to "genuinely not a member".
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, () => ({
            data: { resource: { projectItems: { nodes: [] } } },
            errors: [{ message: 'Resource not accessible by integration' }]
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(502)
        const body = await response.json() as { error: string }
        expect(body.error).toContain('Resource not accessible by integration')
    })

    it('rejects a write to an item that is on the project but hidden by the board\'s view filter (Codex review)', async () => {
        // Project membership alone isn't enough for a view-scoped board — the
        // whole point of adding one is to restrict exposure to the view's
        // filtered subset, so a write must also be checked against it.
        const viewItemsResponse = {
            data: { repositoryOwner: { projectV2: { items: { nodes: [
                { id: 'item-1', content: { __typename: 'Issue', url: 'https://github.com/acme/widgets/issues/1', title: 'Visible' } }
            ] } } } }
        }
        const app = await createApp(
            () => viewItemsResponse,
            () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap' } } } }),
            'default',
            () => ({ data: { repositoryOwner: { projectV2: { title: 'Acme Roadmap', view: { name: 'Sprint board' } } } } }),
            { ...UNUSED_ACTIONS, close: async () => {} }
        )
        await app.request('/api/todo-boards', { method: 'POST', body: JSON.stringify({ url: 'https://github.com/orgs/acme/projects/9/views/8' }) })

        // Item #1 is in the view's filtered items — write succeeds.
        const visible = await app.request('/api/todo-boards/github.com%3A%3Aacme%3A%3A9%3A%3Aview%3A%3A8/items/close', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/acme/widgets/issues/1' })
        })
        expect(visible.status).toBe(200)

        // Item #2 is on the same project (membership check alone would pass
        // it) but absent from the view's filtered items — write rejected.
        const hidden = await app.request('/api/todo-boards/github.com%3A%3Aacme%3A%3A9%3A%3Aview%3A%3A8/items/close', {
            method: 'POST',
            body: JSON.stringify({ url: 'https://github.com/acme/widgets/issues/2' })
        })
        expect(hidden.status).toBe(400)
    })
})

describe('POST /api/todo-boards/:id/items/close', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('closes via the close action and reports success', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            close: async (target, comment) => { calls.push([target, comment]) }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, comment: 'done' })
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual([[{ host: 'github.com', url: VALID_ITEM_URL, isPullRequest: false }, 'done']])
    })

    it('rejects an item URL that does not belong to the board', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: 'https://attacker.example/a/b/issues/1' })
        })
        expect(response.status).toBe(400)
    })

    it('404s for an unknown board', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards/unknown/items/close', {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(404)
    })

    it('403s for a non-default namespace', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'some-other-namespace')
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(403)
    })

    it('surfaces a failed gh invocation as a 502, not a silently-swallowed success', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            close: async () => { throw new Error('gh issue close failed: already closed') }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/close`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(502)
    })
})

describe('POST /api/todo-boards/:id/items/reopen', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('reopens via the reopen action, deriving isPullRequest from the URL (not part of the request body)', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            reopen: async (target, comment) => { calls.push([target, comment]) }
        })
        // isPullRequest is deliberately not a client-supplied field at all —
        // the server derives it from the validated URL path, so a /pull/ URL
        // must come back as isPullRequest: true without the client ever
        // asserting that itself.
        const pullUrl = 'https://github.com/heavygee/hapi-demo-board/pull/1'
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/reopen`, {
            method: 'POST',
            body: JSON.stringify({ url: pullUrl })
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual([[{ host: 'github.com', url: pullUrl, isPullRequest: true }, undefined]])
    })
})

describe('POST /api/todo-boards/:id/items/comment', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('comments via the comment action', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            comment: async (target, body) => { calls.push([target, body]) }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comment`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, body: 'Looks good' })
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual([[{ host: 'github.com', url: VALID_ITEM_URL, isPullRequest: false }, 'Looks good']])
    })

    it('rejects an empty comment body', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comment`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, body: '' })
        })
        expect(response.status).toBe(400)
    })
})

describe('POST /api/todo-boards/:id/items/status', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('sets status via the setStatus action, resolving project number/owner/field from the board', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            setStatus: async (target) => { calls.push(target) }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/status`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, status: 'Done' })
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual([{
            host: 'github.com',
            ownerLogin: 'heavygee',
            projectNumber: 6,
            url: VALID_ITEM_URL,
            fieldName: 'Status',
            status: 'Done'
        }])
    })

    it('rejects a missing status value', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/status`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(400)
    })

    it('clears status via status: null, resolving to the setStatus action with status null (Codex review)', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            setStatus: async (target) => { calls.push(target) }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/status`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, status: null })
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual([{
            host: 'github.com',
            ownerLogin: 'heavygee',
            projectNumber: 6,
            url: VALID_ITEM_URL,
            fieldName: 'Status',
            status: null
        }])
    })
})

describe('GET /api/todo-boards/:id/items/assignable-users', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('fetches assignable users scoped to the item\'s own repo, not the board\'s project owner', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, (target) => {
            calls.push(target)
            return {
                data: {
                    repository: {
                        assignableUsers: {
                            nodes: [
                                { login: 'alice', avatarUrl: 'https://example.com/alice.png', name: 'Alice A' },
                                { login: 'bob', avatarUrl: 'https://example.com/bob.png', name: null }
                            ]
                        }
                    }
                }
            }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignable-users?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            users: [
                { login: 'alice', avatarUrl: 'https://example.com/alice.png', name: 'Alice A' },
                { login: 'bob', avatarUrl: 'https://example.com/bob.png', name: null }
            ]
        })
        expect(calls).toEqual([{ host: 'github.com', owner: 'heavygee', repo: 'hapi-demo-board' }])
    })

    it('forwards a trimmed search term as the GraphQL query filter (Codex review: a page with no pagination needed server-side search)', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, (target) => {
            calls.push(target)
            return { data: { repository: { assignableUsers: { nodes: [] } } } }
        })
        const response = await app.request(
            `/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignable-users?url=${encodeURIComponent(VALID_ITEM_URL)}&search=${encodeURIComponent('  alice  ')}`
        )
        expect(response.status).toBe(200)
        expect(calls).toEqual([{ host: 'github.com', owner: 'heavygee', repo: 'hapi-demo-board', query: 'alice' }])
    })

    it('omits the query filter entirely for a blank/whitespace-only search term', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, (target) => {
            calls.push(target)
            return { data: { repository: { assignableUsers: { nodes: [] } } } }
        })
        const response = await app.request(
            `/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignable-users?url=${encodeURIComponent(VALID_ITEM_URL)}&search=${encodeURIComponent('   ')}`
        )
        expect(response.status).toBe(200)
        expect(calls).toEqual([{ host: 'github.com', owner: 'heavygee', repo: 'hapi-demo-board', query: undefined }])
    })

    it('rejects a missing url query parameter', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignable-users`)
        expect(response.status).toBe(400)
    })

    it('404s for an unknown board', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/unknown/items/assignable-users?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(404)
    })

    it('403s for a non-default namespace', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'some-other-namespace')
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignable-users?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(403)
    })

    it('rejects an item URL that is not a member of this board\'s project — same gate as every write action', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, () => ({
            data: { resource: { projectItems: { nodes: [] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignable-users?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(400)
    })

    it('surfaces a GraphQL-level error as a 502', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, () => ({
            errors: [{ message: 'boom' }]
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignable-users?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(502)
    })
})

describe('GET /api/todo-boards/:id/items/comments', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    const makeCommentNode = (overrides: Partial<{
        id: string
        author: { login: string; avatarUrl: string } | null
        authorAssociation: string
        body: string
        createdAt: string
        url: string
        isMinimized: boolean
        minimizedReason: string | null
    }> = {}) => ({
        id: 'IC_1',
        author: { login: 'octocat', avatarUrl: 'https://example.com/octocat.png' },
        authorAssociation: 'MEMBER',
        body: 'Looks good to me',
        createdAt: '2026-10-27T00:00:00Z',
        url: 'https://github.com/heavygee/hapi-demo-board/issues/1#issuecomment-1',
        isMinimized: false,
        minimizedReason: null,
        ...overrides
    })

    it('fetches comments for the item via a single resource(url:) query, scoped by host + url only', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, undefined, undefined, (target) => {
            calls.push(target)
            return { data: { resource: { comments: { nodes: [makeCommentNode()] } } } }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comments?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            comments: [{
                id: 'IC_1',
                author: { login: 'octocat', avatarUrl: 'https://example.com/octocat.png' },
                authorAssociation: 'MEMBER',
                body: 'Looks good to me',
                createdAt: '2026-10-27T00:00:00Z',
                url: 'https://github.com/heavygee/hapi-demo-board/issues/1#issuecomment-1',
                isMinimized: false,
                minimizedReason: null
            }]
        })
        expect(calls).toEqual([{ host: 'github.com', url: VALID_ITEM_URL }])
    })

    // Same resource(url:) + inline-fragment shape works unchanged for a PR —
    // no isPullRequest branching needed, unlike a number-keyed
    // issue(number:)/pullRequest(number:) pair would require.
    it('reads comments for a PR item the same way, via the PullRequest fragment', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, undefined, undefined, () => ({
            data: { resource: { comments: { nodes: [makeCommentNode({ id: 'IC_pr' })] } } }
        }))
        const pullUrl = 'https://github.com/heavygee/hapi-demo-board/pull/9'
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comments?url=${encodeURIComponent(pullUrl)}`)
        expect(response.status).toBe(200)
        const body = await response.json() as { comments: Array<{ id: string }> }
        expect(body.comments.map(c => c.id)).toEqual(['IC_pr'])
    })

    it('drops a malformed (null) comment node instead of throwing', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, undefined, undefined, () => ({
            data: { resource: { comments: { nodes: [makeCommentNode(), null] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comments?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(200)
        const body = await response.json() as { comments: unknown[] }
        expect(body.comments).toHaveLength(1)
    })

    it('maps a null comment author to null instead of crashing (deleted account)', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, undefined, undefined, () => ({
            data: { resource: { comments: { nodes: [makeCommentNode({ author: null })] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comments?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(200)
        const body = await response.json() as { comments: Array<{ author: unknown }> }
        expect(body.comments[0]?.author).toBeNull()
    })

    it('rejects a missing url query parameter', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comments`)
        expect(response.status).toBe(400)
    })

    it('404s for an unknown board', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/unknown/items/comments?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(404)
    })

    it('403s for a non-default namespace', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'some-other-namespace')
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comments?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(403)
    })

    it('rejects an item URL that is not a member of this board\'s project — same gate as every write action', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, () => ({
            data: { resource: { projectItems: { nodes: [] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comments?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(400)
    })

    it('surfaces a GraphQL-level error as a 502', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, undefined, undefined, undefined, undefined, () => ({
            errors: [{ message: 'boom' }]
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/comments?url=${encodeURIComponent(VALID_ITEM_URL)}`)
        expect(response.status).toBe(502)
    })
})

describe('POST /api/todo-boards/:id/items/assignees', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('adds and removes assignees in a single call via the setAssignees action', async () => {
        const calls: unknown[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            setAssignees: async (target, addLogins, removeLogins) => { calls.push([target, addLogins, removeLogins]) }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignees`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, addLogins: ['alice'], removeLogins: ['bob'] })
        })
        expect(response.status).toBe(200)
        expect(calls).toEqual([[
            { host: 'github.com', url: VALID_ITEM_URL, isPullRequest: false },
            ['alice'],
            ['bob']
        ]])
    })

    it('rejects a request with neither addLogins nor removeLogins', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignees`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL })
        })
        expect(response.status).toBe(400)
    })

    it('rejects a request with both arrays empty', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignees`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, addLogins: [], removeLogins: [] })
        })
        expect(response.status).toBe(400)
    })

    it('404s for an unknown board', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards/unknown/items/assignees', {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, addLogins: ['alice'] })
        })
        expect(response.status).toBe(404)
    })

    it('403s for a non-default namespace', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'some-other-namespace')
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignees`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, addLogins: ['alice'] })
        })
        expect(response.status).toBe(403)
    })

    it('rejects an item URL that is not a member of this board\'s project — same gate as every write action', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, () => ({
            data: { resource: { projectItems: { nodes: [] } } }
        }))
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignees`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, addLogins: ['alice'] })
        })
        expect(response.status).toBe(400)
    })

    it('surfaces a failed gh invocation as a 502, not a silently-swallowed success', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            setAssignees: async () => { throw new Error('gh issue edit failed') }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items/assignees`, {
            method: 'POST',
            body: JSON.stringify({ url: VALID_ITEM_URL, addLogins: ['alice'] })
        })
        expect(response.status).toBe(502)
    })
})

describe('GET /api/todo-boards/:id/issue-templates', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    const BUG_REPORT_YAML = `
name: Bug report
body:
  - type: input
    id: contact
    attributes:
      label: Contact
    validations:
      required: false
`

    it('404s for an unknown board', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards/unknown/issue-templates?repo=heavygee/hapi')
        expect(response.status).toBe(404)
    })

    it('403s for a non-default namespace', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'some-other-namespace')
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/hapi`, undefined)
        expect(response.status).toBe(403)
    })

    it('400s for a missing or malformed repo query parameter', async () => {
        const app = await createApp(() => ({ data: {} }))
        const missing = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates`)
        expect(missing.status).toBe(400)
        const malformed = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=not-a-slug`)
        expect(malformed.status).toBe(400)
    })

    it('returns blankAllowed: true with an empty template list when the repo has no .github/ISSUE_TEMPLATE directory at all', async () => {
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            () => ({ data: { repository: { issueTemplateDir: null } } })
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/hapi`)
        expect(response.status).toBe(200)
        const body = await response.json() as { templates: unknown[]; blankAllowed: boolean; githubNewIssueUrl: string }
        expect(body.templates).toEqual([])
        expect(body.blankAllowed).toBe(true)
        expect(body.githubNewIssueUrl).toBe('https://github.com/heavygee/hapi/issues/new/choose')
    })

    it('inherits templates and blank_issues_enabled from the owner\'s .github repo when the target has no directory of its own', async () => {
        const calls: string[] = []
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            (target: { repo: string }) => {
                calls.push(target.repo)
                if (target.repo === '.github') {
                    return {
                        data: {
                            repository: {
                                issueTemplateDir: {
                                    entries: [
                                        { name: 'bug_report.yml', object: { text: BUG_REPORT_YAML } },
                                        { name: 'config.yml', object: { text: 'blank_issues_enabled: false' } }
                                    ]
                                }
                            }
                        }
                    }
                }
                return { data: { repository: { issueTemplateDir: null } } }
            }
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/no-local-templates`)
        expect(response.status).toBe(200)
        const body = await response.json() as { templates: Array<{ id: string }>; blankAllowed: boolean }
        expect(body.templates.map(t => t.id)).toEqual(['bug_report.yml'])
        expect(body.blankAllowed).toBe(false)
        expect(calls).toEqual(['no-local-templates', '.github'])
    })

    it('does not fall back to .github when the target repo has its own directory, even an empty one', async () => {
        const calls: string[] = []
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            (target: { repo: string }) => {
                calls.push(target.repo)
                return { data: { repository: { issueTemplateDir: { entries: [] } } } }
            }
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/hapi`)
        expect(response.status).toBe(200)
        expect(calls).toEqual(['hapi'])
    })

    it('does not recurse when the target repo being queried is already .github', async () => {
        const calls: string[] = []
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            (target: { repo: string }) => {
                calls.push(target.repo)
                return { data: { repository: { issueTemplateDir: null } } }
            }
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/.github`)
        expect(response.status).toBe(200)
        expect(calls).toEqual(['.github'])
    })

    it('falls back to the empty result when the owner has no .github repo either', async () => {
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            () => ({ data: { repository: { issueTemplateDir: null } } })
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/no-local-templates`)
        expect(response.status).toBe(200)
        const body = await response.json() as { templates: unknown[]; blankAllowed: boolean }
        expect(body.templates).toEqual([])
        expect(body.blankAllowed).toBe(true)
    })

    // Review finding: `gh api graphql` treats GitHub's NOT_FOUND for a
    // nonexistent repo as a command failure and rejects, rather than
    // resolving with an `errors` array in the response body — the far more
    // common real-world case than the "resolves with errors" shape the
    // previous test covers, since most owners have no `.github` repo at
    // all. Without a dedicated try/catch around the optional fallback, this
    // rejection reached the route's outer catch and 502'd "New card" for
    // the ordinary case of a valid repo with no templates of its own.
    it('still returns the empty result, not a 502, when the .github lookup rejects with NOT_FOUND (gh exits nonzero)', async () => {
        const calls: string[] = []
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            (target: { repo: string }) => {
                calls.push(target.repo)
                if (target.repo === '.github') {
                    throw new GhGraphqlNotFoundError("gh api graphql failed: GraphQL: Could not resolve to a Repository with the name '.github'. (repository)")
                }
                return { data: { repository: { issueTemplateDir: null } } }
            }
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/no-local-templates`)
        expect(response.status).toBe(200)
        const body = await response.json() as { templates: unknown[]; blankAllowed: boolean }
        expect(body.templates).toEqual([])
        expect(body.blankAllowed).toBe(true)
        expect(calls).toEqual(['no-local-templates', '.github'])
    })

    // Review finding, second pass: the first fix swallowed *every* error from
    // the .github fallback, which would also hide a genuine auth/rate-limit/
    // transport failure on that specific call as if it just meant "no
    // inherited templates" — silently serving the wrong (empty) policy for a
    // repo whose .github fallback might really have templates. Only
    // GhGraphqlNotFoundError (the repo genuinely doesn't exist) should be
    // swallowed; anything else must still 502.
    it('still 502s when the .github lookup fails for a reason other than NOT_FOUND', async () => {
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            (target: { repo: string }) => {
                if (target.repo === '.github') {
                    throw new Error('gh api graphql failed: HTTP 401: Bad credentials')
                }
                return { data: { repository: { issueTemplateDir: null } } }
            }
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/no-local-templates`)
        expect(response.status).toBe(502)
    })

    it('parses .yml forms and .md legacy templates, skips config.yml as a template entry, and reads blank_issues_enabled from it', async () => {
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            () => ({
                data: {
                    repository: {
                        issueTemplateDir: {
                            entries: [
                                { name: 'bug_report.yml', object: { text: BUG_REPORT_YAML } },
                                { name: 'feature_request.md', object: { text: '---\nname: Feature\n---\nBody text' } },
                                { name: 'config.yml', object: { text: 'blank_issues_enabled: false' } }
                            ]
                        }
                    }
                }
            })
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/hapi`)
        expect(response.status).toBe(200)
        const body = await response.json() as { templates: Array<{ id: string; kind: string }>; blankAllowed: boolean; githubNewIssueUrl: string }
        expect(body.templates.map(t => t.id)).toEqual(['bug_report.yml', 'feature_request.md'])
        expect(body.templates[0]?.kind).toBe('form')
        expect(body.templates[1]?.kind).toBe('legacy')
        expect(body.blankAllowed).toBe(false)
        expect(body.githubNewIssueUrl).toBe('https://github.com/heavygee/hapi/issues/new/choose')
    })

    it('honors blank_issues_enabled: false even when every template is unsupported (operator ruling, hapi#238: do not fall back to blank)', async () => {
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            () => ({
                data: {
                    repository: {
                        issueTemplateDir: {
                            entries: [
                                { name: 'weird.yml', object: { text: 'body:\n  - type: some-future-type\n    id: x\n    attributes:\n      label: X' } },
                                { name: 'config.yml', object: { text: 'blank_issues_enabled: false' } }
                            ]
                        }
                    }
                }
            })
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/hapi`)
        const body = await response.json() as { templates: Array<{ kind: string }>; blankAllowed: boolean; githubNewIssueUrl: string }
        expect(body.templates[0]?.kind).toBe('unsupported')
        expect(body.blankAllowed).toBe(false)
        expect(body.githubNewIssueUrl).toBe('https://github.com/heavygee/hapi/issues/new/choose')
    })

    it('surfaces a GraphQL-level error as a 502', async () => {
        const app = await createApp(
            () => ({ data: {} }), undefined, 'default', undefined, UNUSED_ACTIONS, ALWAYS_MEMBER, undefined,
            () => ({ errors: [{ message: 'rate limited' }] })
        )
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/issue-templates?repo=heavygee/hapi`)
        expect(response.status).toBe(502)
    })
})

describe('POST /api/todo-boards/:id/items (create a card)', () => {
    beforeEach(() => {
        process.env.HAPI_BOARD_OWNER = 'heavygee'
        process.env.HAPI_BOARD_NUMBER = '6'
    })

    it('creates the issue then adds it to the project, in that order, and reports the created url', async () => {
        const calls: string[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            createIssue: async (target) => {
                calls.push(`createIssue:${target.repo}`)
                return 'https://github.com/heavygee/hapi/issues/42'
            },
            addItemToProject: async (target) => {
                calls.push(`addItemToProject:${target.issueUrl}`)
            }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items`, {
            method: 'POST',
            body: JSON.stringify({ repo: 'heavygee/hapi', title: 'New bug', body: '### What\n\nBroke.', labels: ['bug'], assignees: [] })
        })
        expect(response.status).toBe(200)
        const body = await response.json() as { ok: true; url: string }
        expect(body.url).toBe('https://github.com/heavygee/hapi/issues/42')
        expect(calls).toEqual(['createIssue:heavygee/hapi', 'addItemToProject:https://github.com/heavygee/hapi/issues/42'])
    })

    it('404s for an unknown board', async () => {
        const app = await createApp(() => ({ data: {} }))
        const response = await app.request('/api/todo-boards/unknown/items', {
            method: 'POST',
            body: JSON.stringify({ repo: 'heavygee/hapi', title: 'T', body: 'B' })
        })
        expect(response.status).toBe(404)
    })

    it('403s for a non-default namespace', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'some-other-namespace')
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items`, {
            method: 'POST',
            body: JSON.stringify({ repo: 'heavygee/hapi', title: 'T', body: 'B' })
        })
        expect(response.status).toBe(403)
    })

    it('400s for a malformed body (bad repo slug, missing title)', async () => {
        const app = await createApp(() => ({ data: {} }))
        const badRepo = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items`, {
            method: 'POST',
            body: JSON.stringify({ repo: 'not-a-slug', title: 'T', body: 'B' })
        })
        expect(badRepo.status).toBe(400)
        const missingTitle = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items`, {
            method: 'POST',
            body: JSON.stringify({ repo: 'heavygee/hapi', body: 'B' })
        })
        expect(missingTitle.status).toBe(400)
    })

    it('surfaces a failed createIssue as a 502 without attempting to add anything to the project', async () => {
        const calls: string[] = []
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            createIssue: async () => { throw new Error('gh issue create failed: repo not found') },
            addItemToProject: async () => { calls.push('should-not-be-called') }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items`, {
            method: 'POST',
            body: JSON.stringify({ repo: 'heavygee/hapi', title: 'T', body: 'B' })
        })
        expect(response.status).toBe(502)
        expect(calls).toEqual([])
    })

    it('surfaces a created-but-not-added-to-board failure distinctly, including the created url', async () => {
        const app = await createApp(() => ({ data: {} }), undefined, 'default', undefined, {
            ...UNUSED_ACTIONS,
            createIssue: async () => 'https://github.com/heavygee/hapi/issues/42',
            addItemToProject: async () => { throw new Error('gh project item-add failed') }
        })
        const response = await app.request(`/api/todo-boards/${DEFAULT_BOARD_ID}/items`, {
            method: 'POST',
            body: JSON.stringify({ repo: 'heavygee/hapi', title: 'T', body: 'B' })
        })
        expect(response.status).toBe(502)
        const body = await response.json() as { error: string; url: string }
        expect(body.error).toContain('https://github.com/heavygee/hapi/issues/42')
        expect(body.url).toBe('https://github.com/heavygee/hapi/issues/42')
    })
})
