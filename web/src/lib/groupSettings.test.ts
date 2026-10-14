import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    GROUP_SETTINGS_STORAGE_KEY,
    applyGroupDisplayNames,
    getGroupCustomName,
    isGroupPinned,
    loadGroupSettings,
    resolveGroupDisplayName,
    saveGroupSettings,
    sortPinnedGroupsFirst,
    type GroupSettings
} from './groupSettings'

const GROUP_KEY_A = 'machine-a::/home/user/project-a'
const GROUP_KEY_B = 'machine-b::/home/user/project-b'

beforeEach(() => {
    localStorage.clear()
})

afterEach(() => {
    localStorage.clear()
})

describe('loadGroupSettings', () => {
    it('returns empty settings when storage is empty', () => {
        expect(loadGroupSettings()).toEqual({})
    })

    it('round-trips pinned and name entries through save', () => {
        const settings: GroupSettings = {
            [GROUP_KEY_A]: { pinned: true },
            [GROUP_KEY_B]: { name: 'Work stuff' }
        }
        saveGroupSettings(settings)
        expect(loadGroupSettings()).toEqual(settings)
    })

    it('returns empty settings for corrupt JSON', () => {
        localStorage.setItem(GROUP_SETTINGS_STORAGE_KEY, '{not json')
        expect(loadGroupSettings()).toEqual({})
    })

    it('ignores non-object payloads and invalid entries', () => {
        localStorage.setItem(GROUP_SETTINGS_STORAGE_KEY, JSON.stringify(['a', 'b']))
        expect(loadGroupSettings()).toEqual({})

        localStorage.setItem(GROUP_SETTINGS_STORAGE_KEY, JSON.stringify({
            [GROUP_KEY_A]: { pinned: 'yes', name: 42 },
            [GROUP_KEY_B]: null,
            [GROUP_KEY_A + '2']: { pinned: false, name: '   ' }
        }))
        expect(loadGroupSettings()).toEqual({})
    })

    it('keeps valid fields alongside invalid ones in the same entry', () => {
        localStorage.setItem(GROUP_SETTINGS_STORAGE_KEY, JSON.stringify({
            [GROUP_KEY_A]: { pinned: true, name: 7 }
        }))
        expect(loadGroupSettings()).toEqual({ [GROUP_KEY_A]: { pinned: true } })
    })
})

describe('accessors', () => {
    it('isGroupPinned only treats explicit true as pinned', () => {
        const settings: GroupSettings = { [GROUP_KEY_A]: { pinned: true } }
        expect(isGroupPinned(settings, GROUP_KEY_A)).toBe(true)
        expect(isGroupPinned(settings, GROUP_KEY_B)).toBe(false)
        expect(isGroupPinned({}, GROUP_KEY_A)).toBe(false)
    })

    it('getGroupCustomName returns the stored name or null', () => {
        const settings: GroupSettings = { [GROUP_KEY_A]: { name: 'Renamed' } }
        expect(getGroupCustomName(settings, GROUP_KEY_A)).toBe('Renamed')
        expect(getGroupCustomName(settings, GROUP_KEY_B)).toBeNull()
    })

    it('resolveGroupDisplayName falls back to the path display name', () => {
        expect(resolveGroupDisplayName({}, GROUP_KEY_A, '/home/user/project-a')).toBe('user/project-a')
        expect(resolveGroupDisplayName({ [GROUP_KEY_A]: { name: 'Custom' } }, GROUP_KEY_A, '/home/user/project-a')).toBe('Custom')
    })
})

describe('applyGroupDisplayNames', () => {
    it('overrides display names only for groups with a custom name', () => {
        const groups = [
            { key: GROUP_KEY_A, displayName: 'user/project-a' },
            { key: GROUP_KEY_B, displayName: 'user/project-b' }
        ]
        const settings: GroupSettings = { [GROUP_KEY_A]: { name: 'Custom' } }
        expect(applyGroupDisplayNames(groups, settings)).toEqual([
            { key: GROUP_KEY_A, displayName: 'Custom' },
            { key: GROUP_KEY_B, displayName: 'user/project-b' }
        ])
    })

    it('does not mutate the input array', () => {
        const groups = [{ key: GROUP_KEY_A, displayName: 'user/project-a' }]
        applyGroupDisplayNames(groups, { [GROUP_KEY_A]: { name: 'Custom' } })
        expect(groups[0].displayName).toBe('user/project-a')
    })
})

describe('sortPinnedGroupsFirst', () => {
    it('floats pinned groups to the top preserving relative order', () => {
        const groups = [
            { key: GROUP_KEY_A },
            { key: GROUP_KEY_B },
            { key: 'machine-c::/home/user/project-c' }
        ]
        const settings: GroupSettings = { [GROUP_KEY_B]: { pinned: true } }
        const sorted = sortPinnedGroupsFirst(groups, settings)
        expect(sorted.map(g => g.key)).toEqual([
            GROUP_KEY_B,
            GROUP_KEY_A,
            'machine-c::/home/user/project-c'
        ])
    })

    it('returns an equally ordered copy when nothing is pinned', () => {
        const groups = [{ key: GROUP_KEY_A }, { key: GROUP_KEY_B }]
        const sorted = sortPinnedGroupsFirst(groups, {})
        expect(sorted).not.toBe(groups)
        expect(sorted).toEqual(groups)
    })
})
