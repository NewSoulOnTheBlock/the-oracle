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
  author?: string
}

export interface Speaker {
  id: string
  name: string
  handle?: string
}

export interface KnownPerson {
  id: string
  name: string
  handle: string | null
  messageCount: number
  firstSeen: Date
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

    -- A person is distinct from an audience. One audience can hold many people
    -- (a group), and one person can appear in several (a group and a DM).
    create table if not exists people (
      id            text primary key,
      name          text not null default '',
      handle        text,
      first_seen    timestamptz not null default now(),
      last_seen     timestamptz not null default now(),
      message_count int not null default 0
    );

    alter table messages add column if not exists person_id   text;
    alter table messages add column if not exists author_name text;

    create index if not exists messages_person_idx on messages (person_id, id desc);
  `)
}

/**
 * Records who spoke. Name and handle are refreshed every time because people
 * rename themselves, and the newest is the one The Oracle should use.
 */
export const rememberPerson = async (speaker: Speaker) => {
  const { rows } = await pool.query(
    `insert into people (id, name, handle, message_count)
     values ($1, $2, $3, 1)
     on conflict (id) do update
       set name = excluded.name,
           handle = coalesce(excluded.handle, people.handle),
           last_seen = now(),
           message_count = people.message_count + 1
     returning (xmax = 0) as is_new, message_count`,
    [speaker.id, speaker.name, speaker.handle ?? null],
  )
  return { isNew: rows[0].is_new as boolean, messageCount: rows[0].message_count as number }
}

/** Everyone who has ever spoken into this audience, most recent first. */
export const peopleInAudience = async (petitionerId: string): Promise<KnownPerson[]> => {
  const { rows } = await pool.query(
    `select p.id, p.name, p.handle, p.message_count, p.first_seen
     from people p
     where p.id in (
       select distinct person_id from messages
       where petitioner_id = $1 and person_id is not null
     )
     order by p.last_seen desc
     limit 25`,
    [petitionerId],
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    handle: r.handle,
    messageCount: r.message_count,
    firstSeen: r.first_seen,
  }))
}

/** Everyone The Oracle has ever met, most recently seen first. */
export const listPeople = async (limit = 200) => {
  const { rows } = await pool.query(
    `select id, name, handle, message_count, first_seen, last_seen
     from people order by last_seen desc limit $1`,
    [limit],
  )
  return rows
}

/**
 * The conversations a person took part in, replies included. Selecting only
 * their own rows would return half a dialogue, since The Oracle's answers carry
 * no person_id — so this pulls whole audiences the person has spoken into.
 */
export const historyForPerson = async (personId: string, limit = 400) => {
  const { rows } = await pool.query(
    `select petitioner_id, role, content, author_name, created_at
     from messages
     where petitioner_id in (
       select distinct petitioner_id from messages where person_id = $1
     )
     order by id desc limit $2`,
    [personId, limit],
  )
  return rows.reverse()
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
    `select role, content, author_name from messages
     where petitioner_id = $1 order by id desc limit $2`,
    [id, TRANSCRIPT_WINDOW],
  )
  return rows.reverse().map((r) => ({
    role: r.role,
    content: r.content,
    ...(r.author_name ? { author: r.author_name } : {}),
  }))
}

export const appendMessage = async (
  id: string,
  role: Turn["role"],
  content: string,
  speaker?: Speaker,
) => {
  await pool.query(
    `insert into messages (petitioner_id, role, content, person_id, author_name)
     values ($1, $2, $3, $4, $5)`,
    [id, role, content, speaker?.id ?? null, speaker?.name ?? null],
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
