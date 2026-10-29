import Database from 'better-sqlite3'
import { MIGRATIONS } from './migrations'

export type DB = Database.Database

export function openDatabase(file: string): DB {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrate(db)
  return db
}

export function migrate(db: DB): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      const m = MIGRATIONS[v]
      if (typeof m === 'string') db.exec(m)
      else m(db)
      db.pragma(`user_version = ${v + 1}`)
    })()
  }
}
