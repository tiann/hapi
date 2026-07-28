import type { Config } from 'tailwindcss'

export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            screens: {
                // Dedicated split breakpoint for the sessions layout. Some compact
                // Android tablets (e.g. OPPO Pad mini) report a landscape CSS
                // viewport below Tailwind's `lg` (1024px) despite having enough
                // physical space, so they fall back to single-column. 920px lets
                // those tablets show the split view while staying clear of phone
                // landscape widths.
                split: '920px'
            },
            maxWidth: {
                content: 'var(--content-max-w, 960px)'
            }
        }
    },
    plugins: []
} satisfies Config

