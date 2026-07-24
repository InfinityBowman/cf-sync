---
layout: home

hero:
  name: cf-sync
  text: Sync engine for Cloudflare Durable Objects
  tagline: Server-authoritative, Linear-style sync — optimistic mutations, offline support, presence, and collaborative text, with TanStack DB on the client.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Why cf-sync?
      link: /guide/why
    - theme: alt
      text: GitHub
      link: https://github.com/InfinityBowman/cf-sync-engine

features:
  - icon: 🏛️
    title: Server-authoritative
    details: The Durable Object is the only writer of canonical state. Clients are optimistic caches that always converge — no conflict-resolution puzzles in app code.
  - icon: ⚡
    title: Optimistic out of the box
    details: Define a mutator once; it runs instantly on the client and authoritatively on the server. Rollback, rebase, and replay are the engine's job, not yours.
  - icon: 📴
    title: Offline that survives reloads
    details: An IndexedDB mirror hydrates the UI instantly, and a durable outbox replays offline mutations exactly once when connectivity returns.
  - icon: 🧩
    title: One shared definition
    details: defineApp bundles schema, mutators, presence shape, and the migration chain into one object both bundles import — server and client can't disagree.
  - icon: 👥
    title: Presence & collaborative text
    details: Typed ephemeral presence with built-in throttling, and an optional Yjs add-on for character-level merging on the fields that need it.
  - icon: ☁️
    title: Cloudflare-native
    details: Workers + Durable Objects + DO SQLite only. One DO per workspace, hibernating WebSockets, R2 archive. No external database tier to operate.
---
