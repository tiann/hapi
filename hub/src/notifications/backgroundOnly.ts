import type { Session } from '../sync/syncEngine'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

export function shouldSuppressBackgroundNotification(
    session: Session,
    visibilityTracker: VisibilityTracker | null,
    backgroundOnly: boolean
): boolean {
    return backgroundOnly
        && visibilityTracker !== null
        && visibilityTracker.hasVisibleConnection(session.namespace)
}
