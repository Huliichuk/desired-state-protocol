import './suppress-warnings.js'
import { DatabaseSync } from 'node:sqlite'

/**
 * `node:sqlite` keeps the runtime free of native build steps, which matters for
 * a protocol implementation people are expected to clone and run.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  return db
}
