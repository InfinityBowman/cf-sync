/**
 * The Standard Schema interface (https://standardschema.dev), vendored per the
 * spec's own guidance so `@cf-sync/protocol` adds no dependency for it. Any
 * standard-schema library (zod, valibot, arktype) satisfies this structurally;
 * TanStack DB's `schema` option accepts the same interface.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>
    readonly types?: Types<Input, Output> | undefined
  }

  export type Result<Output> = SuccessResult<Output> | FailureResult

  export interface SuccessResult<Output> {
    readonly value: Output
    readonly issues?: undefined
  }

  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>
  }

  export interface Issue {
    readonly message: string
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined
  }

  export interface PathSegment {
    readonly key: PropertyKey
  }

  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input
    readonly output: Output
  }

  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input']

  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output']
}

/** Renders validation issues as a compact single-line summary for error messages. */
export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  const shown = issues.slice(0, 5).map((issue) => {
    const path = issue.path
      ?.map((segment) => String(typeof segment === 'object' && segment !== null ? segment.key : segment))
      .join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
  const hidden = issues.length - shown.length
  return shown.join('; ') + (hidden > 0 ? `; +${hidden} more` : '')
}
