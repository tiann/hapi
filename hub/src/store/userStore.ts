import type { Database } from 'bun:sqlite'

import type { StoredUser } from './types'
import { addUser, getUser, getUsersByPlatform, getUsersByPlatformAndNamespace, removeUser, setUserLanguage } from './users'

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

    addUser(platform: string, platformUserId: string, namespace: string, language?: string | null): StoredUser {
        return addUser(this.db, platform, platformUserId, namespace, language)
    }

    setUserLanguage(platform: string, platformUserId: string, language: string | null): void {
        setUserLanguage(this.db, platform, platformUserId, language)
    }

    removeUser(platform: string, platformUserId: string): boolean {
        return removeUser(this.db, platform, platformUserId)
    }
}
