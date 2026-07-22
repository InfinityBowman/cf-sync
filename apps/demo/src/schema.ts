export const SCHEMA_VERSION = 'demo-1'

export interface Todo extends Record<string, unknown> {
  id: string
  title: string
  completed: boolean
  createdAt: string
}
