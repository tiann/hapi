/**
 * Generic local-session import contract for the web client. One
 * REST pair per flavor: GET /api/:flavor/sessions and POST
 * /api/:flavor/import-sessions. Flavor display fields arrive flattened into
 * list items (the hub flattens the source descriptor's `extra`).
 */

export type LocalSessionImportFlavor = 'codex' | 'pi' | 'opencode' | 'claude'

export type LocalSessionListItem = {
    id: string
    title: string
    lastUserMessage?: string | null
    cwd?: string | null
    file: string
    modifiedAt: number
    messageCount?: number
    hapiSessionId?: string
    importState?: 'importing' | 'complete' | 'failed' | 'diverged'
    [flavorField: string]: unknown
}

export type LocalSessionListResponse =
    | { success: true; sessions: LocalSessionListItem[]; machineId?: string }
    | { success: false; error: string; sessions: []; machineId?: string }

export type LocalSessionImportResult = {
    sessionId: string
    hapiSessionId?: string
    action?: 'created' | 'updated' | 'unchanged'
    appended?: number
    error?: { code: string; message: string }
    [flavorField: string]: unknown
}

export type LocalSessionImportResponse =
    | { success: true; results: LocalSessionImportResult[]; machineId?: string }
    | { success: false; error: string; results: LocalSessionImportResult[]; machineId?: string }

export type LocalSessionImportPayload = {
    sessionIds: string[]
    cwd?: string | null
    machineId?: string | null
    model?: string | null
    modelReasoningEffort?: string | null
    permissionMode?: string | null
    serviceTier?: string | null
    collaborationMode?: string | null
    [requestField: string]: unknown
}

/** Client surface the generic import hook needs; ApiClient implements it. */
export type LocalSessionImportApi = {
    getLocalSessions(flavor: LocalSessionImportFlavor, cwd?: string | null, machineId?: string | null): Promise<LocalSessionListResponse>
    importLocalSessions(flavor: LocalSessionImportFlavor, payload: LocalSessionImportPayload): Promise<LocalSessionImportResponse>
}

export function localSessionsPath(flavor: LocalSessionImportFlavor, cwd?: string | null, machineId?: string | null): string {
    const params = new URLSearchParams()
    if (cwd?.trim()) params.set('cwd', cwd.trim())
    if (machineId?.trim()) params.set('machineId', machineId.trim())
    const query = params.size ? `?${params.toString()}` : ''
    return `/api/${flavor}/sessions${query}`
}

export function localImportPath(flavor: LocalSessionImportFlavor): string {
    return `/api/${flavor}/import-sessions`
}