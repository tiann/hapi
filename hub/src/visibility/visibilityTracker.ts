export type VisibilityState = 'visible' | 'hidden'

export class VisibilityTracker {
    private readonly visibleConnections = new Map<string, Set<string>>()
    private readonly subscriptionToNamespace = new Map<string, string>()
    private readonly lastVisibleByNamespace = new Map<string, number>()

    registerConnection(subscriptionId: string, namespace: string, state: VisibilityState): void {
        this.removeConnection(subscriptionId)
        this.subscriptionToNamespace.set(subscriptionId, namespace)
        if (state === 'visible') {
            this.addVisibleConnection(namespace, subscriptionId)
            this.markVisible(namespace)
        }
    }

    setVisibility(subscriptionId: string, namespace: string, state: VisibilityState): boolean {
        const trackedNamespace = this.subscriptionToNamespace.get(subscriptionId)
        if (!trackedNamespace || trackedNamespace !== namespace) {
            return false
        }

        if (state === 'visible') {
            this.addVisibleConnection(trackedNamespace, subscriptionId)
            this.markVisible(trackedNamespace)
            return true
        }

        this.removeVisibleConnection(trackedNamespace, subscriptionId)
        return true
    }

    removeConnection(subscriptionId: string): void {
        const namespace = this.subscriptionToNamespace.get(subscriptionId)
        if (!namespace) {
            return
        }

        this.subscriptionToNamespace.delete(subscriptionId)
        this.removeVisibleConnection(namespace, subscriptionId)
    }

    hasVisibleConnection(namespace: string): boolean {
        const visible = this.visibleConnections.get(namespace)
        return Boolean(visible && visible.size > 0)
    }

    hasRecentVisibleConnection(namespace: string, windowMs: number): boolean {
        if (!this.hasVisibleConnection(namespace)) {
            return false
        }
        return this.hasRecentVisibleActivity(namespace, windowMs)
    }

    hasRecentVisibleActivity(namespace: string, windowMs: number): boolean {
        const lastVisible = this.lastVisibleByNamespace.get(namespace)
        if (!lastVisible) {
            return false
        }
        return Date.now() - lastVisible <= windowMs
    }

    isVisibleConnection(subscriptionId: string): boolean {
        const namespace = this.subscriptionToNamespace.get(subscriptionId)
        if (!namespace) {
            return false
        }
        const visible = this.visibleConnections.get(namespace)
        return Boolean(visible && visible.has(subscriptionId))
    }

    markVisible(namespace: string): void {
        this.lastVisibleByNamespace.set(namespace, Date.now())
    }

    private addVisibleConnection(namespace: string, subscriptionId: string): void {
        const existing = this.visibleConnections.get(namespace)
        if (existing) {
            existing.add(subscriptionId)
            return
        }

        this.visibleConnections.set(namespace, new Set([subscriptionId]))
    }

    private removeVisibleConnection(namespace: string, subscriptionId: string): void {
        const existing = this.visibleConnections.get(namespace)
        if (!existing) {
            return
        }

        existing.delete(subscriptionId)
        if (existing.size === 0) {
            this.visibleConnections.delete(namespace)
        }
    }
}
