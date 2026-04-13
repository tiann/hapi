import type { Database } from 'bun:sqlite'

import type { StoredOpenClawConversation } from './types'
import {
    findOpenClawConversationByExternalId,
    getOpenClawConversationByNamespace,
    getOpenClawConversationByExternalId,
    getOpenClawConversationByUserKey,
    getOrCreateOpenClawConversation,
    rebindOpenClawConversation,
    updateOpenClawConversation
} from './openclawConversations'

export class OpenClawConversationStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getOrCreateConversation(
        namespace: string,
        userKey: string,
        defaults?: { externalId?: string; title?: string | null; status?: string }
    ): StoredOpenClawConversation {
        return getOrCreateOpenClawConversation(this.db, namespace, userKey, defaults)
    }

    getConversationByNamespace(id: string, namespace: string): StoredOpenClawConversation | null {
        return getOpenClawConversationByNamespace(this.db, id, namespace)
    }

    getConversationByUserKey(namespace: string, userKey: string): StoredOpenClawConversation | null {
        return getOpenClawConversationByUserKey(this.db, namespace, userKey)
    }

    getConversationByExternalId(namespace: string, externalId: string): StoredOpenClawConversation | null {
        return getOpenClawConversationByExternalId(this.db, namespace, externalId)
    }

    findConversationByExternalId(externalId: string): StoredOpenClawConversation | null {
        return findOpenClawConversationByExternalId(this.db, externalId)
    }

    rebindConversation(
        id: string,
        namespace: string,
        externalId: string,
        title?: string | null
    ): StoredOpenClawConversation | null {
        return rebindOpenClawConversation(this.db, id, namespace, externalId, title)
    }

    updateConversation(
        id: string,
        namespace: string,
        patch: {
            title?: string | null
            status?: string
            connected?: boolean
            thinking?: boolean
            lastError?: string | null
        }
    ): StoredOpenClawConversation | null {
        return updateOpenClawConversation(this.db, id, namespace, patch)
    }
}
