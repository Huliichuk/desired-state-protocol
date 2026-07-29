import './suppress-warnings.js'
import { DatabaseSync } from 'node:sqlite'

/**
 * The mock provider's backing store. `:memory:` is supported, so tests exercise
 * exactly the code path a server uses.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}
