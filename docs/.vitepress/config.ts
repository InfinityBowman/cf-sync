import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'cf-sync',
  description:
    'Server-authoritative sync engine on Cloudflare Durable Objects, with TanStack DB on the client',
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'API', link: '/reference/', activeMatch: '/reference/' },
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
            { text: 'Reading data', link: '/guide/reading-data' },
            { text: 'Offline & persistence', link: '/guide/offline-persistence' },
          ],
        },
        {
          text: 'Production',
          items: [
            { text: 'Testing your app', link: '/guide/testing' },
            { text: 'Operations', link: '/guide/operations' },
            { text: 'Limits & costs', link: '/guide/limits-and-costs' },
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
      '/reference/': [
        {
          text: 'API reference',
          items: [
            { text: 'Overview', link: '/reference/' },
            { text: 'SyncClient', link: '/reference/sync-client' },
            { text: 'Collections', link: '/reference/collections' },
            { text: 'defineApp & the definition kit', link: '/reference/define-kit' },
            { text: 'Server', link: '/reference/server' },
            { text: 'Test engine', link: '/reference/testing' },
            { text: 'Yjs fields', link: '/reference/yjs' },
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
