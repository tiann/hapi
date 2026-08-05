import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StorageUsagePie } from './StorageUsagePie'

const labels = {
    title: 'Relative share',
    empty: 'No storage to chart yet.',
    database: 'Database',
    wal: 'Write-ahead log',
    shm: 'Shared memory',
}

describe('StorageUsagePie', () => {
    it('shows empty state when all sizes are zero', () => {
        render(<StorageUsagePie usage={{ databaseBytes: 0, walBytes: 0, shmBytes: 0 }} labels={labels} />)
        expect(screen.getByText(labels.empty)).toBeInTheDocument()
    })

    it('updates the center readout when a legend option is selected', () => {
        render(
            <StorageUsagePie
                usage={{ databaseBytes: 700, walBytes: 200, shmBytes: 100 }}
                labels={labels}
            />,
        )

        expect(screen.getByTestId('storage-pie-center')).toHaveTextContent('Database')
        expect(screen.getByRole('img', { name: /Relative share/i })).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('storage-pie-legend-wal'))
        expect(screen.getByTestId('storage-pie-center')).toHaveTextContent('Write-ahead log')
        expect(screen.getByTestId('storage-pie-center')).toHaveTextContent('20%')
    })
})
