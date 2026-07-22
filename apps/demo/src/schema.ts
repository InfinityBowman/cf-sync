export const SCHEMA_VERSION = 'demo-2'

export interface Todo extends Record<string, unknown> {
  id: string
  title: string
  completed: boolean
  createdAt: string
  /** Added in demo-2; existing rows get 'normal' via the migrateSchema hook. */
  priority: 'low' | 'normal' | 'high'
}
