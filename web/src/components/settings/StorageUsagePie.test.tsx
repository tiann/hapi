import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StorageUsagePie } from './StorageUsagePie'

const labels = {
    title: 'Relative share',
    empty: 'No storage to chart yet.',
    database: 'Database',
    wal: 'Write-ahead log',
    shm: 'Shared memory',
    total: 'Total',
    path: 'Path',
}

describe('StorageUsagePie', () => {
    it('shows empty state when all sizes are zero', () => {
        render(
            <StorageUsagePie
                usage={{ databaseBytes: 0, walBytes: 0, shmBytes: 0 }}
                totalBytes={0}
                path="/tmp/hapi.db"
                labels={labels}
            />,
        )
        expect(screen.getByText(labels.empty)).toBeInTheDocument()
    })

    it('updates the center readout when a legend option is selected', () => {
        render(
            <StorageUsagePie
                usage={{ databaseBytes: 700, walBytes: 200, shmBytes: 100 }}
                totalBytes={1000}
                path="/tmp/hapi.db"
                labels={labels}
            />,
        )

        expect(screen.getByTestId('storage-pie-center')).toHaveTextContent('Database')
        expect(screen.getByRole('img', { name: /Relative share/i })).toBeInTheDocument()
        expect(screen.getByTestId('storage-pie-total')).toHaveTextContent('Total')
        expect(screen.getByTestId('storage-pie-total')).toHaveTextContent('1000 B')
        expect(screen.getByTestId('storage-pie-path')).toHaveTextContent('/tmp/hapi.db')

        fireEvent.click(screen.getByTestId('storage-pie-legend-wal'))
        expect(screen.getByTestId('storage-pie-center')).toHaveTextContent('Write-ahead log')
        expect(screen.getByTestId('storage-pie-center')).toHaveTextContent('20%')
    })
})
