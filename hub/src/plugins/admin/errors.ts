import { PluginInstallError, PluginStateLockError } from '@hapi/protocol/plugins/foundation'

export function pluginAdminErrorStatus(error: unknown): 400 | 404 | 409 | 500 {
    if (error instanceof PluginStateLockError) {
        return 409
    }
    if (error instanceof PluginInstallError) {
        return error.code === 'plugin-install-target-exists' ? 409 : 400
    }
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('was not found')) {
        return 404
    }
    if (message.includes('is not active') || message.includes('does not have an active notification channel')) {
        return 409
    }
    if (message.includes('plugins.json') || message.includes('must not store declared secret') || message.includes('secret-like field') || message.includes('redacted placeholder')) {
        return 409
    }
    if (message.includes('cannot be deleted')) {
        return 400
    }
    return 500
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
