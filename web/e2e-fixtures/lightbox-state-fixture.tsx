import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ZoomableLightbox } from '../src/components/ZoomableLightbox'
import '../src/index.css'

const params = new URLSearchParams(location.search)
const imageSrc = 'data:image/png;base64,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'
const stableSize = { width: 400, height: 700 }
function Fixture() {
    const [tick, setTick] = useState(0)
    const [open, setOpen] = useState(true)
    const [key, setKey] = useState<string | null>(params.has('deferred') ? null : 'image-a')
    const [size, setSize] = useState<{ width: number; height: number } | null>(params.has('deferred') || params.has('measured') ? null : stableSize)
    useEffect(() => {
        const update = (event: Event) => {
            const action = (event as CustomEvent).detail
            if (action?.size !== undefined) setSize(action.size)
            if (action?.key !== undefined) setKey(action.key)
            if (action?.open !== undefined) setOpen(action.open)
            setTick(value => value + 1)
        }
        window.addEventListener('lightbox-fixture-update', update)
        return () => window.removeEventListener('lightbox-fixture-update', update)
    }, [])
    return <>
        <span data-testid="tick">{tick}</span>
        <ZoomableLightbox open={open} onClose={() => setOpen(false)} title="image.png" ariaLabel="Fixture image"
            fitContentKey={key} fitOnOpen={!params.has('no-fit')}
            fitContentSize={size && (params.has('stable') ? size : { ...size })}>
            {params.has('image') ? <img src={imageSrc} alt="Test image" width={size?.width ?? 400} height={size?.height ?? 700} draggable={false} /> : <svg width={size?.width ?? 400} height={size?.height ?? 700} viewBox="0 0 400 700" role="img" aria-label="Test image">
                <rect width="400" height="700" fill="white" />
                <text x="25" y="65" fill="black" fontSize="22">Pan and zoom remain unchanged</text>
                <path d="M0 350H400M200 0V700" stroke="blue" strokeWidth="8" />
            </svg>}
        </ZoomableLightbox>
    </>
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>)
