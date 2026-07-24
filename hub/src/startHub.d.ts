export interface HubInstance {
    stop(): Promise<void>
}

export interface StartHubOptions {
    args?: string[]
    cliVersion?: string
}

export function startHub(options?: StartHubOptions): Promise<HubInstance>
