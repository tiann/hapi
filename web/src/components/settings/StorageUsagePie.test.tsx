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
    it('keeps total and path in the empty state', () => {
        render(
            <StorageUsagePie
                usage={{ databaseBytes: 0, walBytes: 0, shmBytes: 0 }}
                totalBytes={0}
                path="/tmp/hapi.db"
                labels={labels}
            />,
        )
        expect(screen.getByText(labels.empty)).toBeInTheDocument()
        expect(screen.getByTestId('storage-pie-total')).toHaveTextContent('Total')
        expect(screen.getByTestId('storage-pie-total')).toHaveTextContent('0 B')
        expect(screen.getByTestId('storage-pie-path')).toHaveTextContent('/tmp/hapi.db')
    })

    it('uses roving tabindex and updates the center readout on legend select', () => {
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
        expect(screen.getByTestId('storage-pie-legend-database')).toHaveAttribute('tabIndex', '0')
        expect(screen.getByTestId('storage-pie-legend-wal')).toHaveAttribute('tabIndex', '-1')
        expect(screen.getByTestId('storage-pie-legend-shm')).toHaveAttribute('tabIndex', '-1')
        expect(screen.getByRole('listbox')).not.toHaveAttribute('aria-activedescendant')
        expect(screen.getByTestId('storage-pie-total')).toHaveTextContent('1000 B')
        expect(screen.getByTestId('storage-pie-path')).toHaveTextContent('/tmp/hapi.db')

        fireEvent.click(screen.getByTestId('storage-pie-legend-wal'))
        expect(screen.getByTestId('storage-pie-center')).toHaveTextContent('Write-ahead log')
        expect(screen.getByTestId('storage-pie-center')).toHaveTextContent('20%')
        expect(screen.getByTestId('storage-pie-legend-wal')).toHaveAttribute('tabIndex', '0')
        expect(screen.getByTestId('storage-pie-legend-database')).toHaveAttribute('tabIndex', '-1')
    })
})
