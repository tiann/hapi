import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { loadServiceAccount } from './fcmAuth'

export type FcmConfig = {
    projectId: string
    serviceAccountPath: string
    serviceAccount: ReturnType<typeof loadServiceAccount>
}

/**
 * The slice of hub configuration FCM cares about: one path. Env vs
 * settings.json precedence is folded upstream (serverSettings.ts:
 * FCM_SERVICE_ACCOUNT_PATH > fcmServiceAccountPath > null). Everything
 * else — project id included — comes from the service-account JSON the
 * path points at.
 */
export type FcmSettings = {
    fcmServiceAccountPath: string | null
}

export function resolveFcmConfig(settings: FcmSettings): FcmConfig | null {
    const rawPath = settings.fcmServiceAccountPath?.trim()
    if (!rawPath) {
        return null
    }
    const serviceAccountPath = rawPath.replace(/^~/, homedir())
    if (!existsSync(serviceAccountPath)) {
        // Configured-but-broken deserves a warning; unconfigured stays silent.
        console.warn(`[Fcm] Service account file not found (${serviceAccountPath}); FCM disabled`)
        return null
    }

    const serviceAccount = loadServiceAccount(serviceAccountPath)
    const projectId = serviceAccount.project_id || null
    if (!projectId) {
        console.warn(`[Fcm] Service account JSON has no project_id (${serviceAccountPath}); FCM disabled`)
        return null
    }

    return { projectId, serviceAccountPath, serviceAccount }
}
