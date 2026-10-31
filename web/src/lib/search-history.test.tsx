import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSearchHistoryKey, parseSearchHistory, SearchHistoryProvider, useSearchHistory } from './search-history'

function jwt(uid = 1, ns = 'default', exp = 1) {
    return `x.${btoa(JSON.stringify({ uid, ns, exp }))}.x`
}
function Controls() {
    const { state, record, remove, clear, setEnabled } = useSearchHistory()
    return <>
        <output data-testid="state">{JSON.stringify(state)}</output>
        <button onClick={() => record('sessions', ' alpha ')}>session</button>
        <button onClick={() => record('files', 'src/*.ts')}>file</button>
        <button onClick={() => record('outlines', '中文')}>outline</button>
        <button onClick={() => remove('sessions', 'alpha')}>remove</button>
        <button onClick={() => clear('files')}>clear files</button>
        <button onClick={() => clear()}>clear all</button>
        <button onClick={() => setEnabled(!state.enabled)}>toggle</button>
    </>
}
const state = () => JSON.parse(screen.getByTestId('state').textContent!)
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('search history parsing and identity', () => {
    it('isolates Hub, user and namespace but survives token refresh and trailing slashes', () => {
        const key = getSearchHistoryKey('https://hub.test', jwt())
        expect(key).toBe(getSearchHistoryKey('https://hub.test/', jwt(1, 'default', 999)))
        expect(key).not.toBe(getSearchHistoryKey('https://other.test', jwt()))
        expect(key).not.toBe(getSearchHistoryKey('https://hub.test', jwt(2)))
        expect(key).not.toBe(getSearchHistoryKey('https://hub.test', jwt(1, 'other')))
        expect(key).not.toContain(jwt())
        expect(getSearchHistoryKey('', 'invalid')).toBeNull()
        expect(getSearchHistoryKey('', 'x.e30.x')).toBeNull()
    })
    it('recovers from corrupt and malformed data, trims, deduplicates and caps lists', () => {
        expect(parseSearchHistory('{').enabled).toBe(false)
        expect(parseSearchHistory('null').sessions).toEqual([])
        expect(parseSearchHistory(JSON.stringify({ enabled: false, files: 'bad', sessions: [' ', null, 1, ' x ', 'x', ...Array.from({ length: 30 }, (_, i) => `${i}`)] })))
            .toMatchObject({ enabled: false, files: [], outlines: [] })
        const entries = parseSearchHistory(JSON.stringify({ sessions: [' x ', 'x', ...Array.from({ length: 30 }, (_, i) => `${i}`)] })).sessions
        expect(entries).toHaveLength(20)
        expect(entries.slice(0, 2)).toEqual(['x', '0'])
    })
})

describe('scoped history provider', () => {
    it('starts disabled and records nothing until explicitly enabled', () => {
        render(<SearchHistoryProvider storageKey="fresh"><Controls /></SearchHistoryProvider>)
        click('session'); click('file'); click('outline')
        expect(state()).toEqual({ enabled: false, sessions: [], files: [], outlines: [] })
        expect(localStorage.getItem('fresh')).toBeNull()
        click('toggle'); click('session')
        expect(state()).toMatchObject({ enabled: true, sessions: ['alpha'] })
    })
    it('persists three separate lists, moves repeats first and supports removal and clearing', () => {
        const key = 'history-a'
        localStorage.setItem(key, JSON.stringify({ enabled: true, sessions: Array.from({ length: 20 }, (_, i) => `${i}`) }))
        const view = render(<SearchHistoryProvider storageKey={key}><Controls /></SearchHistoryProvider>)
        click('session'); click('file'); click('outline'); click('session')
        expect(state().sessions).toHaveLength(20)
        expect(state().sessions[0]).toBe('alpha')
        expect(state().files).toEqual(['src/*.ts'])
        expect(state().outlines).toEqual(['中文'])
        expect(JSON.parse(localStorage.getItem(key)!)).toEqual(state())
        view.unmount()
        render(<SearchHistoryProvider storageKey={key}><Controls /></SearchHistoryProvider>)
        expect(state().sessions[0]).toBe('alpha')
        click('remove'); click('clear files')
        expect(state().sessions).not.toContain('alpha')
        expect(state().files).toEqual([])
        expect(state().outlines).toEqual(['中文'])
        click('clear all')
        expect(state()).toEqual({ enabled: true, sessions: [], files: [], outlines: [] })
    })
    it('disabling retains old entries, stops new records and permits clearing while disabled', () => {
        render(<SearchHistoryProvider storageKey="a"><Controls /></SearchHistoryProvider>)
        click('toggle')
        click('session'); click('toggle'); click('file')
        expect(state()).toMatchObject({ enabled: false, sessions: ['alpha'], files: [] })
        click('toggle')
        expect(state().sessions).toEqual(['alpha'])
        click('toggle'); click('clear all')
        expect(state()).toEqual({ enabled: false, sessions: [], files: [], outlines: [] })
    })
    it('switches scopes without leaking history or preferences', () => {
        const view = render(<SearchHistoryProvider storageKey="a"><Controls /></SearchHistoryProvider>)
        click('toggle')
        click('session'); click('toggle')
        view.rerender(<SearchHistoryProvider storageKey="b"><Controls /></SearchHistoryProvider>)
        expect(state()).toEqual({ enabled: false, sessions: [], files: [], outlines: [] })
        click('toggle')
        click('file')
        view.rerender(<SearchHistoryProvider storageKey="a"><Controls /></SearchHistoryProvider>)
        expect(state()).toMatchObject({ enabled: false, sessions: ['alpha'], files: [] })
    })
    it('updates from another tab and resets when storage is cleared', () => {
        render(<SearchHistoryProvider storageKey="a"><Controls /></SearchHistoryProvider>)
        act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'b', newValue: '{"enabled":false}' })))
        expect(state().enabled).toBe(false)
        act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'a', newValue: '{"enabled":false,"files":["other"]}' })))
        expect(state()).toMatchObject({ enabled: false, files: ['other'] })
        act(() => window.dispatchEvent(new StorageEvent('storage', { key: null })))
        expect(state()).toEqual({ enabled: false, sessions: [], files: [], outlines: [] })
    })
    it('keeps operating in memory if localStorage reads and writes throw', () => {
        vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked') })
        vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
        render(<SearchHistoryProvider storageKey="a"><Controls /></SearchHistoryProvider>)
        click('toggle')
        click('session'); click('toggle'); click('file')
        expect(state()).toMatchObject({ enabled: false, sessions: ['alpha'], files: [] })
        click('clear all'); click('toggle'); click('outline')
        expect(state()).toMatchObject({ enabled: true, sessions: [], outlines: ['中文'] })
    })
    it('does not store anything without an authenticated scope', () => {
        render(<SearchHistoryProvider storageKey={null}><Controls /></SearchHistoryProvider>)
        click('session'); click('toggle')
        expect(state().enabled).toBe(false)
        expect(localStorage.length).toBe(0)
    })
})
