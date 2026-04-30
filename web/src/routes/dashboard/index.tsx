import { Dashboard } from '@/components/Dashboard'
import { useAppContext } from '@/lib/app-context'
import { useSearch } from '@tanstack/react-router'

export default function DashboardPage() {
    const { api } = useAppContext()
    const { pins } = useSearch({ from: '/sessions/' })
    const initialPinnedIds = pins ? pins.split(',').filter(Boolean) : []
    return <Dashboard api={api} initialPinnedIds={initialPinnedIds} />
}
