import { defineConfig } from 'vitepress'
import docsConfig from '../config.json'

type Entry = { label: string; to?: string; href?: string }
type Section = { label: string; area: string; children: Entry[] }

const sections: Section[] = docsConfig.sections

// `to` is a docs-relative path without the extension — the form config.json ships
// to consumers. VitePress wants a rooted link, with an index page addressed as its
// directory.
function toLink(entry: Entry): string {
  if (entry.href) return entry.href
  return `/${entry.to!.replace(/(^|\/)index$/, '$1')}`
}

function sidebarFor(area: string) {
  return sections
    .filter((section) => section.area === area)
    .map((section) => ({
      text: section.label,
      items: section.children.map((entry) => ({
        text: entry.label,
        link: toLink(entry),
      })),
    }))
}

export default defineConfig({
  title: docsConfig.title,
  description: docsConfig.description,
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'API', link: '/reference/', activeMatch: '/reference/' },
      { text: 'Why cf-sync', link: '/guide/why' },
    ],
    sidebar: {
      '/guide/': sidebarFor('guide'),
      '/reference/': sidebarFor('reference'),
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/InfinityBowman/cf-sync' },
    ],
    search: { provider: 'local' },
    editLink: {
      pattern:
        'https://github.com/InfinityBowman/cf-sync/edit/main/docs/:path',
      text: 'Suggest changes to this page',
    },
    outline: [2, 3],
    footer: {
      message: 'Released under the MIT License.',
    },
  },
})
