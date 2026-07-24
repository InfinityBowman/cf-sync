import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AUTH_CONTEXT,
  defineApp,
  defineMutators,
  defineSchema,
  isPermanentCloseCode,
  type MutatorContext,
} from '../src/index'
import { truncateCloseReason } from '../src/internal'

// Session-control plumbing (DESIGN.md §15): the authContext schema is
// declared with the mutators, carried on the registry, and lifted onto the
// app definition; close codes split permanent from refresh.

const schema = defineSchema({
  studies: z.object({ id: z.string(), title: z.string() }),
})
const authContext = z.object({ role: z.enum(['owner', 'member']), writeAllowed: z.boolean() })

describe('authContext declaration', () => {
  it('rides the registry under AUTH_CONTEXT and survives spread', () => {
    const mutators = defineMutators(
      schema,
      {
        'study.delete': {
          args: z.object({ id: z.string() }),
          apply: (tx, { id }) => tx.del('studies', id),
        },
      },
      { authContext },
    )
    expect(mutators[AUTH_CONTEXT]).toBe(authContext)
    expect({ ...mutators }[AUTH_CONTEXT]).toBe(authContext)
  })

  it('defineApp lifts it onto the definition (crud merge included)', () => {
    const mutators = defineMutators(schema, {}, { authContext })
    const app = defineApp({ version: 1, schema, mutators })
    expect(app.authContext).toBe(authContext)
  })

  it('an app without one has no authContext', () => {
    const app = defineApp({ version: 1, schema })
    expect(app.authContext).toBeUndefined()
  })

  it('types ctx.auth from the schema output', () => {
    // Compile-time assertion: ctx.auth narrows to the authContext output.
    defineMutators(
      schema,
      {
        'study.guarded': {
          apply: (_tx, _args: unknown, ctx) => {
            const _role: 'owner' | 'member' | undefined = ctx.auth?.role
            const _authoritative: boolean = ctx.authoritative
            void _role
            void _authoritative
          },
        },
      },
      { authContext },
    )
    // And without a declaration it stays unknown-shaped but present.
    const ctx: MutatorContext = { clientId: 'c1', authoritative: false }
    expect(ctx.principal).toBeUndefined()
  })
})

describe('close-code space', () => {
  it('splits the permanent band from refresh', () => {
    expect(isPermanentCloseCode(4400)).toBe(true)
    expect(isPermanentCloseCode(4403)).toBe(true)
    expect(isPermanentCloseCode(4499)).toBe(true)
    expect(isPermanentCloseCode(4300)).toBe(false)
    expect(isPermanentCloseCode(4500)).toBe(false)
    expect(isPermanentCloseCode(1000)).toBe(false)
  })

  it('truncates close reasons to the 123-byte cap on codepoint boundaries', () => {
    expect(truncateCloseReason('membership-revoked')).toBe('membership-revoked')
    const long = 'é'.repeat(200) // 2 bytes per codepoint
    const truncated = truncateCloseReason(long)
    expect(new TextEncoder().encode(truncated).byteLength).toBeLessThanOrEqual(123)
    expect(truncated.endsWith('…')).toBe(true)
    // Never splits a multi-byte codepoint: re-encoding round-trips.
    expect(new TextDecoder().decode(new TextEncoder().encode(truncated))).toBe(truncated)
  })
})
