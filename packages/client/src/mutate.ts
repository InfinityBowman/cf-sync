import type { AnyMutators, MutationArgs } from '@cf-sync/protocol'

type NamespaceHeads<K extends string> = K extends `${infer H}.${string}` ? H : K
type NamespaceSub<M, H extends string> = {
  [K in keyof M & `${H}.${string}` as K extends `${H}.${infer R}` ? R : never]: M[K]
}

/**
 * The property-access half of `client.mutate`: dots in mutator names become
 * namespaces, so `'todos.clearCompleted'` is called as
 * `client.mutate.todos.clearCompleted()` — names autocomplete, args are typed
 * from the mutator's schema. (`defineMutators` rejects a name that is both a
 * mutator and a namespace prefix of another, so the tree is unambiguous.)
 */
export type MutateNamespace<M> = {
  [H in NamespaceHeads<keyof M & string>]: H extends keyof M
    ? (...args: MutationArgs<M[H]>) => Promise<void>
    : MutateNamespace<NamespaceSub<M, H>>
}

/**
 * `client.mutate` is both a function and a namespace tree: call it with a
 * mutator name (`mutate('todos.clearCompleted')`) or through properties
 * (`mutate.todos.clearCompleted()`). Both forms are identical at runtime.
 */
export type Mutate<M extends AnyMutators> = (<K extends keyof M & string>(
  name: K,
  ...args: MutationArgs<M[K]>
) => Promise<void>) &
  MutateNamespace<M>

/**
 * Builds the callable namespace tree from the registry's names. The root is a
 * function (the string-name form), so leaves and namespaces are attached with
 * defineProperty — plain assignment would throw for names that shadow
 * non-writable function properties like "name" or "length".
 */
export function buildMutate(names: Iterable<string>, invoke: (name: string, args: unknown) => Promise<void>): any {
  const define = (node: any, key: string, value: unknown): void => {
    Object.defineProperty(node, key, { value, enumerable: true, configurable: true, writable: true })
  }
  const root: any = (name: string, ...rest: unknown[]) => invoke(name, rest[0])
  for (const name of names) {
    const segments = name.split('.')
    let node = root
    for (const segment of segments.slice(0, -1)) {
      if (!Object.prototype.hasOwnProperty.call(node, segment)) define(node, segment, {})
      node = node[segment]
    }
    const leaf = segments[segments.length - 1]!
    const call = (...rest: unknown[]) => invoke(name, rest[0])
    // A registry that dodged defineMutators' prefix check can hold both a
    // mutator "a" and "a.b"; keep any children already attached under the name.
    const existing = Object.prototype.hasOwnProperty.call(node, leaf) ? node[leaf] : undefined
    if (existing !== undefined && typeof existing === 'object') Object.assign(call, existing)
    define(node, leaf, call)
  }
  return root
}
