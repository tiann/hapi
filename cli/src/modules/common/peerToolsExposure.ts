let hubPreference: boolean = true

/** Apply the Hub peer-tool exposure toggle; missing old responses stay enabled. */
export function applyHubPeerToolsEnabled(enabled: boolean): void {
    hubPreference = enabled
}

/** Return whether peer tools and their agent guidance may be exposed. */
export function isHubPeerToolsEnabled(): boolean {
    return hubPreference
}

/** Reset peer-tool exposure state between tests. */
export function resetHubPeerToolsEnabledForTests(): void {
    hubPreference = true
}
