import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CursorChatStoreStatus } from '@hapi/protocol/apiTypes'

type InspectCursorChatStoreOptions = {
    home: string
    workspacePath: string
    cursorSessionId: string
}

function isSafeCursorSessionId(value: string): boolean {
    return value !== '.'
        && value !== '..'
        && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile()
    } catch {
        return false
    }
}

async function hasUniqueLegacyStore(home: string, cursorSessionId: string): Promise<boolean> {
    const chatsRoot = join(home, '.cursor', 'chats')
    let workspaceDrawers: string[]
    try {
        workspaceDrawers = await readdir(chatsRoot)
    } catch {
        return false
    }

    let matches = 0
    for (const workspaceDrawer of workspaceDrawers) {
        const candidate = join(chatsRoot, workspaceDrawer, cursorSessionId, 'store.db')
        if (await isFile(candidate)) {
            matches += 1
            if (matches > 1) {
                return false
            }
        }
    }
    return matches === 1
}

export async function inspectCursorChatStore(
    options: InspectCursorChatStoreOptions
): Promise<CursorChatStoreStatus> {
    const cursorSessionId = options.cursorSessionId.trim()
    const workspacePath = options.workspacePath
    if (!isSafeCursorSessionId(cursorSessionId) || workspacePath.length === 0) {
        return { onDisk: false, store: null }
    }

    const acpStore = join(
        options.home,
        '.cursor',
        'acp-sessions',
        cursorSessionId,
        'store.db'
    )
    if (await isFile(acpStore)) {
        return { onDisk: true, store: 'acp' }
    }

    const workspaceHash = createHash('md5').update(workspacePath).digest('hex')
    const legacyStore = join(
        options.home,
        '.cursor',
        'chats',
        workspaceHash,
        cursorSessionId,
        'store.db'
    )
    if (await isFile(legacyStore)) {
        return { onDisk: true, store: 'legacy' }
    }

    if (await hasUniqueLegacyStore(options.home, cursorSessionId)) {
        return { onDisk: true, store: 'legacy' }
    }

    return { onDisk: false, store: null }
}
