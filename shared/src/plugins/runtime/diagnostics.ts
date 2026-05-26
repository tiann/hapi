import type { PluginDiagnostic } from '../types'
import type { PluginDiagnosticView, PluginReloadItem } from '../admin'

export function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }
    return String(error)
}

export function diagnosticView(
    pluginId: string | undefined,
    diagnostic: Pick<PluginDiagnostic, 'severity' | 'code' | 'message' | 'path'>
): PluginDiagnosticView {
    return {
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        ...(diagnostic.path ? { path: diagnostic.path } : {}),
        ...(pluginId ? { pluginId } : {})
    }
}

export function reloadItemIsOk(item: PluginReloadItem): boolean {
    if (item.action === 'failed' || item.action === 'kept-previous') {
        return false
    }
    return !['invalid', 'failed', 'reload-failed', 'blocked', 'incompatible'].includes(item.status)
}
