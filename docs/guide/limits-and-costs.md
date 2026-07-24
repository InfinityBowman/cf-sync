# Limits & costs

Two kinds of numbers live here: the engine's own caps — designed values, enforced with named errors — and the Cloudflare platform's, which cf-sync inherits. Platform pricing is quoted from [Cloudflare's pricing page](https://developers.cloudflare.com/durable-objects/platform/pricing/) as of early 2026 (post the January 2026 SQLite billing change) — verify against the source before capacity planning.

## Engine limits

| What | Limit | On violation |
|---|---|---|
| Row data (JSON-serialized) | 700,000 bytes | permanent [`RowTooLarge`](/reference/sync-client#mutationerror) rejection |
| Presence state | 8,192 bytes | error frame — never truncated |
| Row id | 256 UTF-16 code units | permanent `InvalidArgs` rejection |
| Table name | identifier-like, ≤ 64 chars | `defineSchema` throws at definition time |
| Yjs field (total doc) | 700,000 bytes | field freezes — reads fine, writes reject `Frozen` |
| Yjs field update (one frame) | 200,000 bytes | `TooLarge` reject; the client guard refuses to send first |
| Yjs field id | 256 UTF-8 bytes | `getDoc` throws |
| Tombstone retention | 10,000 data versions (configurable) | older offline clients re-bootstrap instead of catching up |

The row cap exists so a single row always fits a WebSocket frame with headroom — larger protocol messages are chunked at 900 KB, comfortably under platform frame limits. Rows are for structured state, not payloads: large text belongs in a [Yjs field](/guide/collaborative-text), blobs in R2 with a key in the row ([Troubleshooting](/guide/troubleshooting#a-mutation-rejected-with-rowtoolarge)).

Relevant platform ceilings underneath: 10 GB of SQLite per Durable Object (= per workspace), a 2 MB SQLite row cap (the engine's 700 KB sits well under it), and 30s of CPU per request by default. Per-workspace `stats` — row counts and database size — is scrapeable from the [admin surface](/guide/operations#what-to-monitor).

## Sizing a workspace

A workspace syncs whole to every member — that's the [design](/guide/why#honest-non-goals), and sizing is its one obligation. The practical governor is not the 10 GB storage ceiling but the **bootstrap**: a new client (or one past the tombstone window) downloads every live row. Tens of thousands of rows bootstrap in seconds and hydrate instantly from IndexedDB thereafter; millions of rows in one workspace means you wanted more workspaces (or a different tool — a global feed is not a workspace).

Linear's model is the calibration: a workspace is a team's working set, not your whole database. Cross-workspace data lives in your app's own store, with the workspace holding what the team collaborates on live.

## What a workspace costs

The architecture's cost story is simple: **an idle workspace costs storage and nothing else.** Sockets hibernate — clients stay connected at the edge while the DO is evicted from memory, and duration charges do not accrue during hibernation. The client's keepalive pings are answered by the server's auto-responder without waking the DO. A workspace nobody touches overnight bills zero compute overnight.

When it's awake, three meters run (Workers Paid, after included allotments):

- **Requests** — $0.15/million past 1M/month. Incoming WebSocket messages bill at a 20:1 ratio (20 messages = 1 request); outbound broadcasts are not billed as requests. Every mutation push and every throttled presence frame is one incoming message.
- **Duration** — $12.50/million GB-s past 400k GB-s/month, billed at the DO's 128 MB allocation for wall-clock time awake. This is the meter that matters: it runs while the DO is in memory, and hibernation is what stops it.
- **SQLite** — rows read at $0.001/million past 25 billion/month, rows written at $1.00/million past 50M/month, storage at $0.20/GB-month past 5 GB-months. A mutation writes a handful of rows (data + log + bookkeeping); presence writes none (never stored).

Rough arithmetic for feel, not precision: a 10-person workspace whose members send 1,000 messages each per active day (presence dominates, already client-throttled to 10/s max) produces ~10k incoming messages/day → 500 request-equivalents at 20:1 → ~15k/month, or **1.5% of the included million**. If processing keeps the DO awake a generous two hours a day, that's ~27k GB-s/month — **7% of the included 400k**. The included allotments of one $5 Workers Paid plan cover dozens to hundreds of such workspaces; the marginal cost of workspace #200 is its storage.

The free plan is genuinely usable for development and small apps: 100k requests/day, 13k GB-s/day, 5M row reads/day, 100k row writes/day, 5 GB storage — with SQLite-backed DOs available without a paid plan.

## What keeps the duration meter honest

Duration is the one number an app can accidentally inflate, and the engine's defaults exist to protect it:

- **Presence throttling** (default 100ms, trailing-edge) bounds the message rate per client no matter how fast the mouse moves — presence is the workload that keeps sockets chatty, so its throttle is effectively a duration-billing control.
- **Keepalive pings** (default 25s) are answered without waking the DO — liveness costs no duration.
- **The maintenance alarm** (compaction, R2 export) wakes the DO on its interval — default 6h, or 5min with an [R2 export](/guide/operations#r2-mutation-log-archive) configured. Each wake is brief; an export interval far below the default on thousands of idle workspaces is the one configuration that turns "idle is free" into a steady hum.
- **All DO handlers are synchronous** by design (an engine invariant) — no awaited I/O stretching awake-time per message.

The R2 archive itself bills on [R2's pricing](https://developers.cloudflare.com/r2/pricing/) (storage plus class-A writes, no egress) — at one object per export interval per active workspace, it's noise next to the meters above.

## When you outgrow a number

- **Row too large** → the data wanted to be a Yjs field or an R2 object; see [Troubleshooting](/guide/troubleshooting#a-mutation-rejected-with-rowtoolarge).
- **Workspace too large** → split it; workspaces are cheap by construction and the [admin surface](/guide/operations) exports/imports them.
- **Long-offline clients re-bootstrapping** → raise `compaction.tombstoneRetentionVersions` ([reference](/reference/server#compaction)) and pay storage for the longer catch-up window.
- **A truly hot workspace** (hundreds of concurrent editors) → it still works — hibernating sockets scale to thousands of clients per DO — but the single-DO-per-workspace serialization point is the design's honest ceiling: one writer, one workspace, by intent.
