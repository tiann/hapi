import type { Config } from 'tailwindcss'

export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            maxWidth: {
                content: '960px'
            }
        }
    },
    plugins: []
} satisfies Config

