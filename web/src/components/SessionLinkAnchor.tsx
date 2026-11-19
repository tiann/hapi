import { type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { buildSessionReferencePath } from '@/lib/sessionReference'

type SessionLinkAnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    sessionId: string
    children: ReactNode
}

export function SessionLinkAnchor({ sessionId, onClick, children, ...rest }: SessionLinkAnchorProps) {
    const router = useRouter({ warn: false }) as { navigate?: (opts: unknown) => unknown } | undefined
    const href = buildSessionReferencePath(sessionId)

    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event)
        if (event.defaultPrevented) return
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        if (typeof router?.navigate !== 'function') return

        event.preventDefault()
        void router.navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL
        })
    }

    return (
        <a {...rest} href={href} onClick={handleClick}>
            {children}
        </a>
    )
}
