import { useEffect, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'

interface ImageLightboxProps {
    src: string
    alt?: string
    open: boolean
    onClose: () => void
}

export function ImageLightbox({ src, alt, open, onClose }: ImageLightboxProps) {
    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose()
        },
        [onClose]
    )

    useEffect(() => {
        if (!open) return
        document.addEventListener('keydown', handleKeyDown)
        document.body.style.overflow = 'hidden'
        return () => {
            document.removeEventListener('keydown', handleKeyDown)
            document.body.style.overflow = ''
        }
    }, [open, handleKeyDown])

    if (!open) return null

    return createPortal(
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90"
            onClick={onClose}
        >
            {/* Top-right buttons */}
            <div className="fixed right-4 top-4 z-[101] flex items-center gap-2">
                <button
                    className="rounded-lg bg-white/10 p-2 text-white/80 backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white"
                    title="在新标签页打开"
                    onClick={(e) => {
                        e.stopPropagation()
                        window.open(src, '_blank')
                    }}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                </button>
                <button
                    className="rounded-lg bg-white/10 p-2 text-white/80 backdrop-blur-sm transition-colors hover:bg-white/20 hover:text-white"
                    title="关闭"
                    onClick={(e) => {
                        e.stopPropagation()
                        onClose()
                    }}
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                </button>
            </div>

            {/* Image */}
            <img
                src={src}
                alt={alt ?? 'Preview'}
                className="max-h-[90vh] max-w-[90vw] rounded object-contain"
                onClick={(e) => e.stopPropagation()}
            />
        </div>,
        document.body
    )
}

export function useImageLightbox() {
    const [lightbox, setLightbox] = useState<{ src: string; alt?: string } | null>(null)

    const openLightbox = useCallback((src: string, alt?: string) => {
        setLightbox({ src, alt })
    }, [])

    const closeLightbox = useCallback(() => {
        setLightbox(null)
    }, [])

    const LightboxPortal = lightbox ? (
        <ImageLightbox
            src={lightbox.src}
            alt={lightbox.alt}
            open={true}
            onClose={closeLightbox}
        />
    ) : null

    return { openLightbox, LightboxPortal }
}
