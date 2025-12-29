import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'node:path'

const base = process.env.VITE_BASE_URL || '/'

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
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'mask-icon.svg'],
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
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
                runtimeCaching: [
                    {
                        urlPattern: /^\/api\/sessions$/,
                        handler: 'NetworkFirst',
                        options: {
                            cacheName: 'api-sessions',
                            expiration: {
                                maxEntries: 10,
                                maxAgeSeconds: 60 * 5
                            },
                            networkTimeoutSeconds: 10
                        }
                    },
                    {
                        urlPattern: /^\/api\/sessions\/[^/]+$/,
                        handler: 'NetworkFirst',
                        options: {
                            cacheName: 'api-session-detail',
                            expiration: {
                                maxEntries: 20,
                                maxAgeSeconds: 60 * 5
                            },
                            networkTimeoutSeconds: 10
                        }
                    },
                    {
                        urlPattern: /^\/api\/machines$/,
                        handler: 'NetworkFirst',
                        options: {
                            cacheName: 'api-machines',
                            expiration: {
                                maxEntries: 5,
                                maxAgeSeconds: 60 * 10
                            },
                            networkTimeoutSeconds: 10
                        }
                    },
                    {
                        urlPattern: /^https:\/\/cdn\.socket\.io\/.*/,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'cdn-socketio',
                            expiration: {
                                maxEntries: 5,
                                maxAgeSeconds: 60 * 60 * 24 * 30
                            }
                        }
                    },
                    {
                        urlPattern: /^https:\/\/telegram\.org\/.*/,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'cdn-telegram',
                            expiration: {
                                maxEntries: 5,
                                maxAgeSeconds: 60 * 60 * 24 * 7
                            }
                        }
                    }
                ]
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
