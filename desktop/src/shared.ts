export type Locale = 'zh-CN' | 'en'

export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export type LauncherConfig = {
    workspaceRoots: string[]
    relayEnabled: boolean
    hubPort: number
    locale: Locale
    windowBounds?: {
        width: number
        height: number
        x?: number
        y?: number
    }
    launcherToken?: string
}

export type RuntimeState = {
    status: RuntimeStatus
    error: string | null
    hubHealthy: boolean
    runnerOnline: boolean
    workspaceRootsSynced: boolean
}

export type ConsoleLogEntry = {
    id: string
    source: 'system' | 'hub' | 'runner'
    text: string
    at: number
}

export type StartOptions = {
    config: LauncherConfig
}

export type DesktopApi = {
    getConfig(): Promise<LauncherConfig>
    saveConfig(config: LauncherConfig): Promise<LauncherConfig>
    getState(): Promise<RuntimeState>
    start(): Promise<void>
    stop(): Promise<void>
    openWeb(): Promise<void>
    clearLogs(): Promise<void>
    chooseDirectory(): Promise<string | null>
    onStateChange(callback: (state: RuntimeState) => void): () => void
    onLog(callback: (entry: ConsoleLogEntry) => void): () => void
}
