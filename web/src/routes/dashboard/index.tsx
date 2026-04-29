import { Dashboard } from '@/components/Dashboard'
import { useAppContext } from '@/lib/app-context'
import { useSearch } from '@tanstack/react-router'

export default function DashboardPage() {
    const { api } = useAppContext()
    const { sessionId } = useSearch({ from: '/sessions/' })
    return <Dashboard api={api} initialPinnedId={sessionId ?? null} />
}
