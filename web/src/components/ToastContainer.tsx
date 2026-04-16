import { useNavigate } from '@tanstack/react-router'
import { Toast } from '@/components/ui/Toast'
import { useToast } from '@/lib/toast-context'

export function ToastContainer() {
    const navigate = useNavigate()
    const { toasts, removeToast } = useToast()

    // In grid iframes, toasts are shown inline in the composer status bar instead
    if (toasts.length === 0 || window.self !== window.top) {
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
                            void navigate({
                                to: '/sessions/$sessionId',
                                params: { sessionId: toast.sessionId }
                            })
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
