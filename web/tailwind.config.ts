import type { Config } from 'tailwindcss'

export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            maxWidth: {
                content: 'var(--content-max-w, 960px)'
            }
        }
    },
    plugins: []
} satisfies Config

