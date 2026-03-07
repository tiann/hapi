export type HostDisplayNameParams = {
    displayName?: string
    host?: string
    machineId?: string
    sessionId?: string
}

function normalize(value?: string): string | null {
    const trimmed = value?.trim()
    return trimmed ? trimmed : null
}

export function getHostDisplayName(params: HostDisplayNameParams): string | null {
    const displayName = normalize(params.displayName)
    if (displayName) return displayName

    const host = normalize(params.host)
    if (host) return host

    const machineId = normalize(params.machineId)
    if (machineId) return machineId.slice(0, 8)

    const sessionId = normalize(params.sessionId)
    if (sessionId) return sessionId.slice(0, 8)

    return null
}

function stableHash(str: string): number {
    let hash = 5381
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0
    }
    return Math.abs(hash)
}

const HOST_HUES = [210, 160, 280, 30, 340, 120, 50, 190] as const

export type HostColorStyle = {
    backgroundColor: string
    color: string
    borderColor: string
}

export function getHostColorStyle(hostKey: string): HostColorStyle {
    const hue = HOST_HUES[stableHash(hostKey) % HOST_HUES.length]

    return {
        backgroundColor: `light-dark(hsl(${hue} 30% 92%), hsl(${hue} 20% 22%))`,
        color: `light-dark(hsl(${hue} 40% 35%), hsl(${hue} 30% 75%))`,
        borderColor: `light-dark(hsl(${hue} 25% 82%), hsl(${hue} 15% 32%))`,
    }
}
