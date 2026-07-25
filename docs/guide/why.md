# Why cf-sync

cf-sync is a server-authoritative sync engine for building collaborative, offline-capable apps on Cloudflare. It gives you the Linear-style experience — instant optimistic mutations, real-time propagation, reconnect-and-converge — as a library, on infrastructure you already run: Workers, Durable Objects, and DO SQLite. Nothing else.

## The model in one paragraph

Each **workspace** (a team, a project, a document space — your call) is one Durable Object. The DO's SQLite is the system of record; the server is the *only* writer of canonical state. Clients hold an optimistic cache in TanStack DB, apply named **intent mutations** locally for instant feedback, and push them over a hibernating WebSocket. The DO re-runs each mutator authoritatively, stamps changes with a monotonic version, and broadcasts a data-carrying poke to every connected client. Clients apply the patch as new base state and drop or rebase their optimistic overlay. Convergence is guaranteed by construction — the server's answer always wins.

## What you get for that trade

**No conflict-resolution puzzles in app code.** Mutations are intents (`issue.move`), not field writes. The server enforces invariants once, in one place, with full authority. You never write merge functions for row data.

**One system of record.** No dual writes to a database *and* a sync layer, no cache-invalidation choreography. DO SQLite has point-in-time recovery; the mutation log streams to R2 for archive and analytics.

**Offline as a property, not a feature.** The idempotency contract (per-client `lastMutationId`) means a mutation queued offline replays exactly once, even across reloads. The client persists its mirror and outbox in IndexedDB.

**Schema evolution with teeth.** Every schema change requires a version bump with an explicit migration entry — and the engine *detects* drift (a structural fingerprint per workspace) instead of letting old and new bundles silently corrupt each other's rows.

## Honest non-goals

These are design decisions, not roadmap gaps. If you need one of them, cf-sync is the wrong tool — better to know now:

- **Partial sync / row-level read permissions.** A workspace syncs whole to any member. Size workspaces accordingly (Linear's model: fine for teams, wrong for a global feed).
- **Peer-to-peer or local-first-purist architectures.** The server is authoritative by design. If you want CRDTs all the way down with no authority, look at Jazz or plain Yjs.
- **Cross-workspace transactions.** Moving data between workspaces is an application-level saga.
- **Portability.** cf-sync is Cloudflare-native on purpose. There is no Postgres adapter and there won't be.

## How it compares

The sync space is crowded, and most of these tools are excellent. cf-sync exists in a specific gap: *server-authoritative semantics, on Cloudflare primitives, with no separate backend to operate*. Its design borrows deliberately from prior art — the [architecture document](https://github.com/InfinityBowman/cf-sync-engine/blob/main/ARCHITECTURE.md) cites Replicache, Zero, LiveStore, tldraw sync, and partyserver at file:line granularity.

| | Authority model | Backend you operate | Client store |
|---|---|---|---|
| **cf-sync** | Server-authoritative mutators | None beyond your Worker (DO SQLite is the record) | TanStack DB |
| **Replicache / Zero** | Server-authoritative | Your own push/pull endpoints + Postgres (Zero: plus zero-cache) | Replicache KV / Zero queries |
| **LiveStore** | Event-sourcing, client-side materialization | CF sync backend or others | Client SQLite |
| **ElectricSQL** | Postgres-authoritative (read-path sync) | Postgres + Electric service | Shapes into your store |
| **PartyKit / partyserver** | None — a room/socket toolkit | Your DO code | BYO |
| **Yjs ecosystems** | CRDT merge, no authority | A relay/persistence provider | Y.Doc |

Points of difference worth calling out:

- **vs. Replicache/Zero** — same protocol lineage (push / pull / poke, the `lastMutationId` contract), but you don't build the backend: the Durable Object *is* the backend, and the per-DO monotonic version eliminates the timestamp races Replicache's docs warn about. If you're on Postgres and want query-driven partial sync, Zero is the stronger fit.
- **vs. LiveStore** — LiveStore is event-sourcing with client-side materialization; cf-sync keeps materialized state on the server and syncs rows. cf-sync's transport learned from LiveStore's CF backend (chunking under the 1MB hibernation limit, `backendId` reset detection).
- **vs. PartyKit** — PartyKit gives you rooms and sockets; the sync semantics (idempotency, cursors, rebase, migrations) are yours to build. cf-sync is those semantics, prebuilt.
- **vs. pure Yjs** — CRDTs merge everything and enforce nothing. cf-sync keeps rows last-write-wins with server-enforced invariants, and offers [Yjs per field](/guide/collaborative-text) where character-level merging genuinely pays for itself — inside the same Durable Object, same socket, same export surface.

## Where the trust comes from

- Invariants are written down and tested: a mutation's data effects and the client's `lastMutationId` advance commit in the same SQLite transaction; permanent app errors still advance it; DO handlers never `await` between reading state and sending frames.
- A seeded multi-client convergence simulation runs in CI against real workerd.
- [`createTestEngine`](/guide/testing) runs the same engine code in plain node, so *your* mutators and migrations are as testable as the engine itself.

Sold, or at least curious? [Get started](/guide/getting-started).
