import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DirectorySection } from './DirectorySection'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

describe('DirectorySection', () => {
    it('stretches the Browse button to the directory input height', () => {
        render(
            <DirectorySection
                directory=""
                suggestions={[]}
                selectedIndex={0}
                isDisabled={false}
                recentPaths={[]}
                onDirectoryChange={vi.fn()}
                onDirectoryFocus={vi.fn()}
                onDirectoryBlur={vi.fn()}
                onDirectoryKeyDown={vi.fn()}
                onSuggestionSelect={vi.fn()}
                onPathClick={vi.fn()}
                onChooseFolder={vi.fn()}
            />
        )

        expect(screen.getByRole('button', { name: 'newSession.browse' })).toHaveClass('self-stretch')
    })

    it('shows the last two path segments while preserving the full path on click', () => {
        const onPathClick = vi.fn()
        const path = 'C:\\Users\\Ananovo\\Downloads\\Agent\\Hapi'

        render(
            <DirectorySection
                directory=""
                suggestions={[]}
                selectedIndex={0}
                isDisabled={false}
                recentPaths={[path]}
                onDirectoryChange={vi.fn()}
                onDirectoryFocus={vi.fn()}
                onDirectoryBlur={vi.fn()}
                onDirectoryKeyDown={vi.fn()}
                onSuggestionSelect={vi.fn()}
                onPathClick={onPathClick}
            />
        )

        const recentPath = screen.getByRole('button', { name: path })
        expect(recentPath).toHaveTextContent('Agent/Hapi')
        expect(recentPath).toHaveAttribute('title', path)

        fireEvent.click(recentPath)
        expect(onPathClick).toHaveBeenCalledWith(path)
    })
})
