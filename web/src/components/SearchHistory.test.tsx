import { useRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SearchHistoryProvider } from '@/lib/search-history'
import { I18nProvider } from '@/lib/i18n-context'
import { SearchHistorySettings } from '@/components/settings/SearchHistorySettings'
import { useSearchHistoryField } from './SearchHistory'

function Field() {
    const [query, setQuery] = useState('')
    const ref = useRef<HTMLInputElement>(null)
    const history = useSearchHistoryField('files', query, setQuery, ref)
    return <div><input aria-label="Find files" ref={ref} value={query} {...history.inputProps} />{history.suggestions}</div>
}
function Fixture() {
    const [show, setShow] = useState(true)
    return <SearchHistoryProvider storageKey="test-history"><I18nProvider>
        {show && <Field />}
        <button onClick={() => setShow(!show)}>close</button>
        <SearchHistorySettings />
    </I18nProvider></SearchHistoryProvider>
}
const history = () => JSON.parse(localStorage.getItem('test-history') ?? '{}')
const input = () => screen.getByRole('textbox', { name: 'Find files' })
const enter = () => fireEvent.keyDown(input(), { key: 'Enter' })
beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('test-history', JSON.stringify({ enabled: true }))
})

describe('search history interaction', () => {
    it('records on Enter or blur, not on every edit, and recalls through keyboard or click', () => {
        render(<Fixture />)
        fireEvent.change(input(), { target: { value: 's' } })
        fireEvent.change(input(), { target: { value: 'src/*.ts' } })
        expect(history().files).toBeUndefined()
        enter()
        fireEvent.change(input(), { target: { value: 'README' } })
        fireEvent.blur(input())
        expect(history().files).toEqual(['README', 'src/*.ts'])
        fireEvent.change(input(), { target: { value: '' } })
        fireEvent.focus(input())
        fireEvent.keyDown(input(), { key: 'ArrowDown' })
        expect(screen.getByRole('button', { name: 'README' })).toHaveFocus()
        fireEvent.click(screen.getByRole('button', { name: 'src/*.ts' }))
        expect(input()).toHaveValue('src/*.ts')
        expect(history().files).toEqual(['src/*.ts', 'README'])
        expect(screen.queryByRole('region', { name: 'Recent searches' })).not.toBeInTheDocument()
    })
    it('suppresses composition fragments and IME Enter, but saves completed text on blur', () => {
        render(<Fixture />)
        fireEvent.compositionStart(input())
        fireEvent.change(input(), { target: { value: 'zhong' } })
        enter()
        fireEvent.blur(input())
        expect(history().files).toBeUndefined()
        fireEvent.change(input(), { target: { value: '中文' } })
        fireEvent.compositionEnd(input())
        fireEvent.blur(input())
        expect(history().files).toEqual(['中文'])
    })
    it('records navigation/unmount and pagehide, including the latest input value', () => {
        render(<Fixture />)
        fireEvent.change(input(), { target: { value: 'one' } })
        act(() => window.dispatchEvent(new Event('pagehide')))
        expect(history().files).toEqual(['one'])
        fireEvent.change(input(), { target: { value: 'two' } })
        fireEvent.click(screen.getByRole('button', { name: 'close' }))
        expect(history().files).toEqual(['two', 'one'])
    })
    it('hides without deleting on disable, skips disabled queries, and clears all while disabled', () => {
        render(<Fixture />)
        fireEvent.change(input(), { target: { value: 'saved' } }); enter()
        fireEvent.change(input(), { target: { value: '' } }); fireEvent.focus(input())
        expect(screen.getByRole('region', { name: 'Recent searches' })).toBeVisible()
        fireEvent.click(screen.getByRole('checkbox', { name: 'Search history' }))
        expect(screen.queryByRole('region', { name: 'Recent searches' })).not.toBeInTheDocument()
        fireEvent.change(input(), { target: { value: 'ignored' } }); enter()
        expect(history().files).toEqual(['saved'])
        fireEvent.click(screen.getByRole('button', { name: 'Clear search history' }))
        expect(history()).toMatchObject({ enabled: false, files: [] })
    })
    it('deletes individual entries, clears only the field history, and dismisses with Escape', () => {
        localStorage.setItem('test-history', JSON.stringify({ enabled: true, sessions: ['keep'], files: ['alpha', 'beta'] }))
        render(<Fixture />)
        fireEvent.focus(input())
        fireEvent.click(screen.getByRole('button', { name: 'Remove search: alpha' }))
        expect(history()).toMatchObject({ files: ['beta'], sessions: ['keep'] })
        fireEvent.keyDown(input(), { key: 'Escape' })
        expect(screen.queryByRole('region')).not.toBeInTheDocument()
        fireEvent.focus(input())
        fireEvent.click(screen.getByRole('button', { name: 'Clear history' }))
        expect(history()).toMatchObject({ files: [], sessions: ['keep'] })
    })
})
