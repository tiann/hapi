import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { execSync } from 'node:child_process'

const base = process.env.VITE_BASE_URL || '/'

// Get version info at build time
function getVersionInfo() {
    try {
        const sha = execSync('git rev-parse HEAD').toString().trim()
        const shortSha = sha.substring(0, 7)
        const buildTime = new Date().toISOString()

        // Check if working directory is dirty
        const status = execSync('git status --porcelain').toString().trim()
        const isDirty = status.length > 0

        // Get git describe output (includes tags and dirty state)
        let gitDescribe = shortSha
        try {
            gitDescribe = execSync('git describe --tags --always --dirty').toString().trim()
        } catch {
            // If git describe fails (no tags), fall back to shortSha
            gitDescribe = shortSha
        }

        return { sha, shortSha, buildTime, isDirty, gitDescribe }
    } catch {
        return { sha: 'unknown', shortSha: 'unknown', buildTime: new Date().toISOString(), isDirty: false, gitDescribe: 'unknown' }
    }
}

// Plugin to inject version into HTML
function injectVersionPlugin(): Plugin {
    const version = getVersionInfo()
    return {
        name: 'inject-version',
        transformIndexHtml(html) {
            return html.replace(
                '</head>',
                `    <meta name="app-version" content="${version.sha}" />\n    <meta name="app-version-short" content="${version.shortSha}" />\n    <meta name="app-build-time" content="${version.buildTime}" />\n    <meta name="app-version-dirty" content="${version.isDirty}" />\n    <meta name="app-version-describe" content="${version.gitDescribe}" />\n  </head>`
            )
        },
    }
}

export default defineConfig({
    server: {
        host: true,
        allowedHosts: ['hapidev.weishu.me'],
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:3006',
                changeOrigin: true
            },
            '/socket.io': {
                target: 'http://127.0.0.1:3006',
                ws: true
            }
        }
    },
    plugins: [
        react(),
        injectVersionPlugin(),
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'mask-icon.svg'],
            strategies: 'injectManifest',
            srcDir: 'src',
            filename: 'sw.ts',
            manifest: {
                name: 'HAPI',
                short_name: 'HAPI',
                description: 'AI-powered development assistant',
                theme_color: '#ffffff',
                background_color: '#ffffff',
                display: 'standalone',
                orientation: 'portrait',
                scope: base,
                start_url: base,
                icons: [
                    {
                        src: 'pwa-64x64.png',
                        sizes: '64x64',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png'
                    },
                    {
                        src: 'maskable-icon-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable'
                    }
                ]
            },
            injectManifest: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}']
            },
            devOptions: {
                enabled: true,
                type: 'module'
            }
        })
    ],
    base,
    resolve: {
        alias: {
            '@': resolve(__dirname, 'src')
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true
    }
})
