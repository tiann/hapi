import type { Database } from 'bun:sqlite'

import type { StoredUser } from './types'
import { addUser, getUser, getUsersByPlatform, getUsersByPlatformAndNamespace, removeUser } from './users'

export class UserStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getUser(platform: string, platformUserId: string): StoredUser | null {
        return getUser(this.db, platform, platformUserId)
    }

    getUsersByPlatform(platform: string): StoredUser[] {
        return getUsersByPlatform(this.db, platform)
    }

    getUsersByPlatformAndNamespace(platform: string, namespace: string): StoredUser[] {
        return getUsersByPlatformAndNamespace(this.db, platform, namespace)
    }

    addUser(
        platform: string,
        platformUserId: string,
        namespace: string,
        credentialFingerprint: string,
    ): StoredUser {
        return addUser(this.db, platform, platformUserId, namespace, credentialFingerprint)
    }

    removeUser(platform: string, platformUserId: string): boolean {
        return removeUser(this.db, platform, platformUserId)
    }
}
