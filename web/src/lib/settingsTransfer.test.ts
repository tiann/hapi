import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { exportSettings, importSettings, SETTINGS_STORAGE_KEYS } from './settingsTransfer'

/**
 * `hapi*` literals in storage code that are NOT settings: data, drafts, history,
 * per-session/per-path UI state, last-used values, dismissals, device-bound
 * state, credentials, trust grants, legacy migration keys, and event names.
 */
const NOT_SETTINGS_KEYS = new Set([
    // Credentials, hub, device-bound state
    'hapi_access_token::',
    'hapi_hub_url',
    'hapi.push.disabled',
    'hapi.push.vapidKey',
    'hapi-sidebar-width',
    // Trust grant: an imported file must not be able to allow link schemes
    'hapi-allowed-schemes',
    // Data, drafts, history, last-used values
    'hapi.codexImportedSessions',
    'hapi.sessionReadState.v1:',
    'hapi.scratchlist.v1.',
    'hapi-recent-skills',
    'hapi:recentPaths',
    'hapi:lastMachineId',
    'hapi:newSession:agent',
    'hapi:newSession:yolo',
    'hapi:newSession:launchSettings:v1',
    'hapi-share-transfers',
    'hapi:composer-drafts',
    'hapi:ask-user-question-drafts',
    'hapi:new-session-form-draft',
    'hapi:queued-edit-recovery',
    'hapi:message-window:v2:',
    // Transient UI state and filters
    'hapi-dir-scroll-',
    'hapi-dir-expanded-',
    'hapi-file-candidate',
    'hapi-files-tab',
    'hapi-mention-inactive-collapsed',
    'hapi-session-list-status',
    'hapi-session-list-unread-only',
    'hapi-session-list-machine-filter',
    'hapi.scratchlist-collapsed.v1.',
    // Onboarding and dismissals
    'hapi.fue.v1.',
    'hapi.fue.v1.scratchlist-toggle',
    'hapi-voice-context-notice',
    'hapi.scratchlist.v2.banner-dismissed.',
    'hapi.scratchlist.v2.migrated.',
    // Legacy keys read only for migration
    'hapi-show-active-sessions-only',
    'hapi-tool-grouping-mode',
    'hapi-terminal-tool-display-mode',
    'hapi-voice-id',
    // Not storage keys: event names and the export file format tag
    'hapi-web-settings',
    'hapi-color-theme-change',
    'hapi-composer-toolbar-layout-change',
    'hapi-session-preview-limit-changed',
    'hapi-tool-card-display-mode-change',
    'hapi-transcription-providers-refresh',
    'hapi-voice-backends-refresh',
    'hapi-voice-input-change',
    'hapi.push.subscriptionChanged',
    'hapi.sessionReadState.changed',
    'hapi:codex-imported-sessions-updated',
])

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceFiles(path)
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
    })
}

describe('SETTINGS_STORAGE_KEYS', () => {
    it('classifies every hapi storage key as setting or not', () => {
        const roots = [resolve(__dirname, '..'), resolve(__dirname, '../../../shared/src')]
        const found = new Set<string>()
        for (const file of roots.flatMap(sourceFiles)) {
            const source = readFileSync(file, 'utf8')
            if (!/localStorage|STORAGE_KEY/.test(source)) continue
            for (const match of source.matchAll(/['"`](hapi[-._:][\w.:-]*)/g)) found.add(match[1])
        }
        const settings = new Set(SETTINGS_STORAGE_KEYS)
        const unclassified = [...found].filter((key) => !settings.has(key) && !NOT_SETTINGS_KEYS.has(key))
        expect(unclassified, 'Add new keys to SETTINGS_STORAGE_KEYS (settingsTransfer.ts) or NOT_SETTINGS_KEYS (this file)').toEqual([])
        expect(SETTINGS_STORAGE_KEYS.filter((key) => NOT_SETTINGS_KEYS.has(key))).toEqual([])
        expect(SETTINGS_STORAGE_KEYS.filter((key) => !found.has(key)), 'Stale settings keys').toEqual([])
    })
})

describe('settings export/import', () => {
    beforeEach(() => localStorage.clear())

    it('round-trips settings and ignores everything else', () => {
        localStorage.setItem('hapi-appearance', 'dark')
        localStorage.setItem('hapi-machine-labels', '{"m1":"Laptop"}')
        localStorage.setItem('hapi_access_token::https://hub', 'secret')
        const file = exportSettings()
        expect(file.settings).toEqual({ 'hapi-appearance': 'dark', 'hapi-machine-labels': '{"m1":"Laptop"}' })

        localStorage.clear()
        localStorage.setItem('hapi-font-scale', '1.2')
        expect(importSettings(JSON.stringify({
            ...file,
            settings: { ...file.settings, 'hapi_hub_url': 'https://evil', 'hapi-lang': 42 },
        }))).toBe(2)
        expect(localStorage.getItem('hapi-appearance')).toBe('dark')
        expect(localStorage.getItem('hapi-machine-labels')).toBe('{"m1":"Laptop"}')
        expect(localStorage.getItem('hapi-font-scale')).toBeNull()
        expect(localStorage.getItem('hapi_hub_url')).toBeNull()
        expect(localStorage.getItem('hapi-lang')).toBeNull()
    })

    it('rejects files that are not settings exports without touching storage', () => {
        localStorage.setItem('hapi-appearance', 'dark')
        expect(() => importSettings('{"settings":{}}')).toThrow()
        expect(() => importSettings('not json')).toThrow()
        expect(localStorage.getItem('hapi-appearance')).toBe('dark')
    })
})
