import type { LibSqlClient } from '@dotlabshq/flect-sdk'
import { drizzle } from 'drizzle-orm/libsql'
import * as sqliteSchema from './schema.js'

export const schema = sqliteSchema
export type DB = ReturnType<typeof createDB>

export function createDB(dbClient: LibSqlClient) {
  return drizzle(dbClient as never, { schema })
}
