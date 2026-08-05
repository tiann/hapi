import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'HAPI',
  description: 'Control your AI agents from anywhere',
  base: '/docs/',

  head: [
    ['link', { rel: 'icon', href: '/docs/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Quick Start', link: '/guide/quick-start' },
      { text: 'App', link: 'https://app.hapi.run', target: '_blank' }
    ],

    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Quick Start', link: '/guide/quick-start' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'PWA', link: '/guide/pwa' }
        ]
      },
      {
        text: 'Guide',
        items: [
          { text: 'How it Works', link: '/guide/how-it-works' },
          { text: 'Voice Assistant', link: '/guide/voice-assistant' },
          { text: 'Why HAPI', link: '/guide/why-hapi' },
          { text: 'FAQ', link: '/guide/faq' }
        ]
      },
      {
        text: 'Agents',
        items: [
          { text: 'Agents', link: '/guide/agents' }
        ]
      },
      {
        text: 'Advanced',
        items: [
          { text: 'Namespace', link: '/guide/namespace' },
          { text: 'Deployment', link: '/guide/deployment' },
          { text: 'Notifications', link: '/guide/notifications' }
        ]
      },
      {
        text: 'API',
        items: [
          { text: 'Native Companion Contract', link: '/api/native-companion-contract' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/tiann/hapi' }
    ],

    footer: {
      message: 'Released under the AGPL-3.0 License.',
      copyright: 'Copyright © 2025-present'
    },

    search: {
      provider: 'local'
    }
  },

  vite: {
    server: {
      allowedHosts: true
    }
  }
})
