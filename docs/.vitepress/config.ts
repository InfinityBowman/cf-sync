import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'cf-sync',
  description:
    'Server-authoritative sync engine on Cloudflare Durable Objects, with TanStack DB on the client',
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Why cf-sync', link: '/guide/why' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'Why cf-sync', link: '/guide/why' },
            { text: 'Getting started', link: '/guide/getting-started' },
          ],
        },
        {
          text: 'Core concepts',
          items: [
            { text: 'Defining your app', link: '/guide/defining-your-app' },
            { text: 'Mutations & optimistic writes', link: '/guide/mutations' },
            { text: 'Schema evolution', link: '/guide/schema-evolution' },
            { text: 'Auth & sessions', link: '/guide/auth' },
          ],
        },
        {
          text: 'Collaboration',
          items: [
            { text: 'Presence', link: '/guide/presence' },
            { text: 'Collaborative text', link: '/guide/collaborative-text' },
          ],
        },
        {
          text: 'Client',
          items: [
            { text: 'Offline & persistence', link: '/guide/offline-persistence' },
          ],
        },
        {
          text: 'Production',
          items: [
            { text: 'Testing your app', link: '/guide/testing' },
            { text: 'Operations', link: '/guide/operations' },
            { text: 'Troubleshooting', link: '/guide/troubleshooting' },
          ],
        },
        {
          text: 'Internals',
          items: [
            {
              text: 'Design document',
              link: 'https://github.com/InfinityBowman/cf-sync-engine/blob/main/DESIGN.md',
            },
          ],
        },
      ],
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/InfinityBowman/cf-sync-engine' },
    ],
    search: { provider: 'local' },
    editLink: {
      pattern:
        'https://github.com/InfinityBowman/cf-sync-engine/edit/main/docs/:path',
      text: 'Suggest changes to this page',
    },
    outline: [2, 3],
    footer: {
      message: 'Released under the MIT License.',
    },
  },
})
