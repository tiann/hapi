import zh from './i18n/zh-CN.json'
import en from './i18n/en.json'
import type { LauncherConfig, Locale } from '../shared'

const dictionaries = {
    'zh-CN': zh,
    en
} as const

export type Dictionary = typeof zh

export function getDictionary(locale: Locale): Dictionary {
    return dictionaries[locale]
}

export function formatStatusLabel(status: string, dict: Dictionary): string {
    if (status === 'starting') return dict.status.starting
    if (status === 'running') return dict.status.running
    if (status === 'stopping') return dict.status.stopping
    if (status === 'error') return dict.status.error
    return dict.status.stopped
}

export function getInitialConfig(): LauncherConfig {
    return {
        workspaceRoots: [],
        relayEnabled: true,
        hubPort: 3006,
        locale: 'zh-CN'
    }
}
