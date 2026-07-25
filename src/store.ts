import { Pool } from "pg"
import { STARTING_STANDING, type Rank } from "./standing.ts"

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? undefined : { rejectUnauthorized: false },
})

export interface Petitioner {
  id: string
  standing: number
  rank: Rank
  notes: string
  summary: string
}

export interface Turn {
  role: "user" | "assistant"
  content: string
}

/** How many raw exchanges stay in the prompt. Older ones live in the summary. */
export const TRANSCRIPT_WINDOW = 20

export const migrate = async () => {
  await pool.query(`
    create table if not exists petitioners (
      id                text primary key,
      standing          int  not null default ${STARTING_STANDING},
      rank              text not null default 'unranked',
      notes             text not null default '',
      summary           text not null default '',
      last_seen         timestamptz not null default now(),
      last_outreach_at  timestamptz
    );

    create table if not exists messages (
      id            bigserial primary key,
      petitioner_id text not null references petitioners(id) on delete cascade,
      role          text not null,
      content       text not null,
      created_at    timestamptz not null default now()
    );

    create index if not exists messages_petitioner_idx
      on messages (petitioner_id, id desc);
  `)
}

export const loadPetitioner = async (id: string): Promise<Petitioner> => {
  const { rows } = await pool.query(
    `insert into petitioners (id) values ($1)
     on conflict (id) do update set last_seen = now()
     returning id, standing, rank, notes, summary`,
    [id],
  )
  return rows[0]
}

export const loadTranscript = async (id: string): Promise<Turn[]> => {
  const { rows } = await pool.query(
    `select role, content from messages
     where petitioner_id = $1 order by id desc limit $2`,
    [id, TRANSCRIPT_WINDOW],
  )
  return rows.reverse()
}

export const appendMessage = async (id: string, role: Turn["role"], content: string) => {
  await pool.query(
    `insert into messages (petitioner_id, role, content) values ($1, $2, $3)`,
    [id, role, content],
  )
}

export const saveStanding = async (id: string, standing: number, rank: Rank) => {
  await pool.query(`update petitioners set standing = $2, rank = $3 where id = $1`, [
    id,
    standing,
    rank,
  ])
}

/**
 * Kept separate from saveStanding because reflection finishes after the reply is
 * sent. If it wrote standing too, a petitioner who answers quickly would have the
 * previous turn's stale value stamped back over their new one.
 */
export const saveRecords = async (id: string, notes: string, summary: string) => {
  await pool.query(`update petitioners set notes = $2, summary = $3 where id = $1`, [
    id,
    notes,
    summary,
  ])
}

/**
 * Petitioners in good standing who have gone quiet and have not already been
 * chased since they last spoke. The last_outreach_at guard is what stops The
 * Oracle contacting the same silent petitioner on every sweep.
 */
export const dueForOutreach = async (threshold: number, silenceMinutes: number) => {
  const { rows } = await pool.query(
    `select id from petitioners
     where standing >= $1
       and last_seen < now() - ($2 || ' minutes')::interval
       and (last_outreach_at is null or last_outreach_at < last_seen)
     limit 25`,
    [threshold, silenceMinutes],
  )
  return rows.map((r) => r.id as string)
}

export const markOutreach = async (id: string) => {
  await pool.query(`update petitioners set last_outreach_at = now() where id = $1`, [id])
}

export const close = () => pool.end()
