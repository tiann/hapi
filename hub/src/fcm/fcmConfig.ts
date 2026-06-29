import { existsSync } from 'node:fs'
import { loadServiceAccount } from './fcmAuth'

export type FcmConfig = {
    projectId: string
    serviceAccountPath: string
    serviceAccount: ReturnType<typeof loadServiceAccount>
}

export function resolveFcmConfig(): FcmConfig | null {
    const serviceAccountPath = process.env.FCM_SERVICE_ACCOUNT_PATH?.trim()
    if (!serviceAccountPath || !existsSync(serviceAccountPath)) {
        return null
    }

    const serviceAccount = loadServiceAccount(serviceAccountPath)
    const projectId = process.env.FCM_PROJECT_ID?.trim()
        || serviceAccount.project_id
        || null
    if (!projectId) {
        console.warn('[Fcm] FCM_PROJECT_ID unset and service account JSON has no project_id')
        return null
    }

    return { projectId, serviceAccountPath, serviceAccount }
}
