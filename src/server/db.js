// Postgres. With DATABASE_URL: a real Postgres server (production).
// Without it: PGlite, the same Postgres compiled to WebAssembly, in DATA_DIR
// (local runs, tests, and a one-box deploy on an encrypted volume).
// Entries are stored as text, byte for byte as signed: jsonb would reorder and
// normalise, and the proofs are over what was received.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SCHEMA = `
create table if not exists entries (
  seq          integer primary key,
  hash         text not null unique,
  parent       text,
  doc_id       text not null unique,
  type         text not null,
  author       text not null,
  on_behalf_of text not null,
  ts           timestamptz not null,
  entry        text not null
);
create index if not exists entries_type on entries (type);
create table if not exists agent_notes (
  agent     text primary key,
  notes_enc text not null,
  updated   timestamptz not null
);
alter table agent_notes add column if not exists read_up_to text;
create table if not exists agent_wakes (
  agent    text primary key,
  url_enc  text not null,
  wake_on  text not null,
  set_at   timestamptz not null
);
create table if not exists agent_drafts (
  id       text primary key,
  agent    text not null,
  body_enc text not null,
  at       timestamptz not null
);
create table if not exists never_say (
  principal text primary key,
  salt      text not null,
  hashes    text not null,
  set_at    timestamptz not null
);
create table if not exists room_check (
  k text primary key,
  v text not null
);
create table if not exists hosted_agents (
  did        text primary key,
  principal  text not null,
  label      text not null,
  token_hash text not null unique,
  seed_enc   text not null,
  created    timestamptz not null
);
create table if not exists sessions (
  token_hash text primary key,
  did        text not null,
  created_ms bigint not null,
  expires_ms bigint not null
);
alter table sessions add column if not exists last_seen_ms bigint;
create index if not exists sessions_did on sessions (did);
create table if not exists passkeys (
  id           text primary key,
  did          text not null,
  public_key   text not null,
  alg          integer not null,
  counter      bigint not null,
  transports   text not null,
  prf          boolean not null,
  wrapped_seed text,
  label        text not null,
  user_verified boolean not null,
  created_ms   bigint not null,
  last_used_ms bigint
);
create index if not exists passkeys_did on passkeys (did);
create table if not exists geb_counts (
  day  text not null,
  what text not null,
  n    integer not null,
  primary key (day, what)
);
`

export async function openDb ({ databaseUrl, dataDir }) {
  let db
  if (databaseUrl) {
    const { default: pg } = await import('pg')
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
    db = { kind: 'postgres', query: (text, params) => pool.query(text, params), close: () => pool.end() }
  } else {
    const { PGlite } = await import('@electric-sql/pglite')
    const dir = join(dataDir, 'pg')
    mkdirSync(dir, { recursive: true })
    const lite = new PGlite(dir)
    await lite.waitReady
    db = { kind: 'pglite', query: (text, params) => lite.query(text, params), close: () => lite.close() }
  }
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt)
  return db
}

export async function insertEntry (db, e) {
  await db.query(
    'insert into entries (seq, hash, parent, doc_id, type, author, on_behalf_of, ts, entry) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [e.seq, e.hash, e.parent, e.document.id, e.type, e.author, e.onBehalfOf, e.timestamp, JSON.stringify(e)],
  )
}

export async function loadEntries (db) {
  const { rows } = await db.query('select entry from entries order by seq asc')
  return rows.map((r) => JSON.parse(r.entry))
}
