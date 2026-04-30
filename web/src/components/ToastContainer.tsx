import { useNavigate } from '@tanstack/react-router'
import { Toast } from '@/components/ui/Toast'
import { useToast } from '@/lib/toast-context'

/** Dispatches a custom event for Mission Control to intercept.
 *  Dashboard listens for this and handles pin/focus logic in-place.
 *  Falls back to normal navigation if Dashboard is not mounted. */
function dispatchFocusSession(sessionId: string): void {
    const event = new CustomEvent('hapi:focus-session', {
        bubbles: true,
        detail: { sessionId }
    })
    document.dispatchEvent(event)
}

export function ToastContainer() {
    const navigate = useNavigate()
    const { toasts, removeToast } = useToast()

    if (toasts.length === 0) {
        return null
    }

    return (
        <div
            className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+1rem)] z-50 flex flex-col items-center gap-2 px-3"
            aria-live="polite"
        >
            {toasts.map((toast) => (
                <Toast
                    key={toast.id}
                    title={toast.title}
                    body={toast.body}
                    className="cursor-pointer"
                    onClick={() => {
                        removeToast(toast.id)
                        if (toast.sessionId) {
                            // Dispatch custom event — Dashboard intercepts to pin/focus in-place.
                            // If Dashboard is not mounted (e.g. user is on another route), this is a no-op
                            // and the user stays on the current page; a separate listener in App can navigate if needed.
                            dispatchFocusSession(toast.sessionId)
                            return
                        }
                        if (toast.url) {
                            void navigate({ to: toast.url })
                        }
                    }}
                    onClose={() => removeToast(toast.id)}
                />
            ))}
        </div>
    )
}
