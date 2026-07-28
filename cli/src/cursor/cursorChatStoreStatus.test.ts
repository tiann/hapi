import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectCursorChatStore } from './cursorChatStoreStatus'

const homes: string[] = []

async function makeHome(): Promise<string> {
    const home = join(tmpdir(), `hapi-cursor-store-${randomUUID()}`)
    homes.push(home)
    await mkdir(home, { recursive: true })
    return home
}

afterEach(async () => {
    await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('inspectCursorChatStore', () => {
    it('finds ACP store.db under the runner user home', async () => {
        const home = await makeHome()
        const store = join(home, '.cursor', 'acp-sessions', 'cursor-1', 'store.db')
        await mkdir(join(store, '..'), { recursive: true })
        await writeFile(store, 'db')

        await expect(inspectCursorChatStore({
            home,
            workspacePath: '/work/project',
            cursorSessionId: 'cursor-1'
        })).resolves.toEqual({ onDisk: true, store: 'acp' })
    })

    it('finds legacy store.db by Cursor workspace hash', async () => {
        const home = await makeHome()
        const workspacePath = '/work/project'
        const workspaceHash = createHash('md5').update(workspacePath).digest('hex')
        const store = join(home, '.cursor', 'chats', workspaceHash, 'cursor-2', 'store.db')
        await mkdir(join(store, '..'), { recursive: true })
        await writeFile(store, 'db')

        await expect(inspectCursorChatStore({
            home,
            workspacePath,
            cursorSessionId: 'cursor-2'
        })).resolves.toEqual({ onDisk: true, store: 'legacy' })
    })

    it('hashes the raw workspace path without trimming valid path bytes', async () => {
        const home = await makeHome()
        const workspacePath = '/work/project '
        const workspaceHash = createHash('md5').update(workspacePath).digest('hex')
        const stores = [
            join(home, '.cursor', 'chats', workspaceHash, 'cursor-spaced-path', 'store.db'),
            join(home, '.cursor', 'chats', 'stale-workspace-hash', 'cursor-spaced-path', 'store.db')
        ]
        for (const store of stores) {
            await mkdir(join(store, '..'), { recursive: true })
            await writeFile(store, 'db')
        }

        await expect(inspectCursorChatStore({
            home,
            workspacePath,
            cursorSessionId: 'cursor-spaced-path'
        })).resolves.toEqual({ onDisk: true, store: 'legacy' })
    })

    it('finds a unique legacy store when the canonical workspace drawer is missing', async () => {
        const home = await makeHome()
        const store = join(home, '.cursor', 'chats', 'legacy-workspace-hash', 'cursor-3', 'store.db')
        await mkdir(join(store, '..'), { recursive: true })
        await writeFile(store, 'db')

        await expect(inspectCursorChatStore({
            home,
            workspacePath: '/work/project-moved-since-chat-was-created',
            cursorSessionId: 'cursor-3'
        })).resolves.toEqual({ onDisk: true, store: 'legacy' })
    })

    it('reports missing when multiple non-canonical legacy stores are present', async () => {
        const home = await makeHome()
        const stores = [
            join(home, '.cursor', 'chats', 'workspace-hash-a', 'cursor-4', 'store.db'),
            join(home, '.cursor', 'chats', 'workspace-hash-b', 'cursor-4', 'store.db')
        ]
        for (const store of stores) {
            await mkdir(join(store, '..'), { recursive: true })
            await writeFile(store, 'db')
        }

        await expect(inspectCursorChatStore({
            home,
            workspacePath: '/work/unrelated-project',
            cursorSessionId: 'cursor-4'
        })).resolves.toEqual({ onDisk: false, store: null })
    })

    it('reports missing without allowing cursorSessionId path traversal', async () => {
        const home = await makeHome()

        await expect(inspectCursorChatStore({
            home,
            workspacePath: '/work/project',
            cursorSessionId: '../../outside'
        })).resolves.toEqual({ onDisk: false, store: null })
    })
})
