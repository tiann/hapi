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
      { text: 'Web App', link: 'https://app.hapi.run', target: '_blank' }
    ],

    sidebar: [
      {
        text: 'Get Started',
        items: [
          { text: 'Quick Start', link: '/guide/quick-start' },
          { text: 'Installation', link: '/guide/installation' },
          { text: 'Native Apps', link: '/guide/native-apps' },
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
          { text: 'Agents', link: '/guide/agents' },
          { text: 'Codex Usage & Limits', link: '/guide/codex-shared-sessions' }
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
        text: 'Русский',
        items: [
          { text: 'Быстрый старт', link: '/guide/quick-start.ru' },
          { text: 'Установка', link: '/guide/installation.ru' },
          { text: 'Нативные приложения', link: '/guide/native-apps.ru' },
          { text: 'Web / PWA', link: '/guide/pwa.ru' },
          { text: 'Как это работает', link: '/guide/how-it-works.ru' },
          { text: 'Голосовой ассистент', link: '/guide/voice-assistant.ru' },
          { text: 'Почему HAPI', link: '/guide/why-hapi.ru' },
          { text: 'FAQ', link: '/guide/faq.ru' },
          { text: 'Агенты', link: '/guide/agents.ru' },
          { text: 'Codex: использование и ограничения', link: '/guide/codex-shared-sessions.ru' },
          { text: 'Пространства имён', link: '/guide/namespace.ru' },
          { text: 'Развёртывание', link: '/guide/deployment.ru' },
          { text: 'Уведомления', link: '/guide/notifications.ru' }
        ]
      },
      {
        text: 'API',
        items: [
          { text: 'Native Companion Contract', link: '/api/native-companion-contract' },
          {
            text: 'Client contract',
            items: [
              { text: 'Overview', link: '/api/client-contract/' },
              { text: 'Auth', link: '/api/client-contract/auth' },
              { text: 'REST', link: '/api/client-contract/rest' },
              { text: 'SSE', link: '/api/client-contract/sse' },
              { text: 'Pagination', link: '/api/client-contract/pagination' },
              { text: 'Messages', link: '/api/client-contract/messages' },
              { text: 'Errors', link: '/api/client-contract/errors' }
            ]
          }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/tiann/hapi' }
    ],

    footer: {
      message: 'Released under the AGPL-3.0 License. · <a href="/docs/privacy.html">Privacy Policy</a>',
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
