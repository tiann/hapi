const DEFAULT_ALLOWED_HOSTS = [
    'hapidev.weishu.me',
    'hapidev.duxiaoxiong.top'
] as const

export function getAllowedHosts(extraHostsValue = ''): string[] {
    const extraHosts = extraHostsValue
        .split(',')
        .map((host: string) => host.trim())
        .filter(Boolean)

    return Array.from(new Set([
        ...DEFAULT_ALLOWED_HOSTS,
        ...extraHosts
    ]))
}
