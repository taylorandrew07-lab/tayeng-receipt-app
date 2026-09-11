/**
 * Isolated database test harness.
 *
 * Runs EVERY migration in supabase/migrations, in order, against a real
 * PostgreSQL (PGlite: Postgres compiled to WASM, running in-process). No
 * Docker, no network, no shared state — each call to freshDb() is a brand new
 * empty database, so tests can never touch production.
 *
 * Supabase provides a few things the migrations assume exist. They are stubbed
 * here as faithfully as matters for RLS:
 *
 *   - the anon / authenticated / service_role roles, with Supabase's DEFAULT
 *     PRIVILEGES. These matter: a table created without RLS is readable by the
 *     anon key precisely BECAUSE of these default grants. Omitting them would
 *     make an exposed table look safe.
 *   - auth.users and auth.uid(), which reads the JWT `sub` claim the same way
 *     Supabase's does.
 *   - storage.buckets / storage.objects / storage.foldername.
 *
 * The migrations themselves run UNMODIFIED — this is also the proof that each
 * one actually executes, which could not previously be checked locally.
 */
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

const SUPABASE_STUB = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key,
  email              text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Mirrors Supabase: the caller's id is the JWT 'sub' claim, or NULL.
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;

create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end $$;
`;

export type Role = "user" | "admin" | "super_admin";

/** Who a query runs as. */
export type Actor =
  | { kind: "anon" }
  | { kind: "service" }
  | { kind: "user"; id: string };

export type TestDb = {
  db: PGlite;
  /** Run `fn` as `actor`, inside a transaction that is always rolled back. */
  as<T>(actor: Actor, fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Create an auth user (the signup trigger provisions profile + settings). */
  createUser(opts?: { approved?: boolean; role?: Role; email?: string }): Promise<string>;
  /** Superuser query — setup and assertions only, bypasses everything. */
  sql<T = Record<string, unknown>>(query: string, params?: unknown[]): Promise<T[]>;
};

export async function freshDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const body = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    try {
      // Atomic per migration, exactly as scripts/db-migrate.mjs applies them.
      await db.exec(`begin;\n${body}\ncommit;`);
    } catch (e) {
      await db.exec("rollback;").catch(() => {});
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }

  const sql = async <T,>(query: string, params: unknown[] = []) =>
    (await db.query<T>(query, params)).rows;

  const as = async <T,>(actor: Actor, fn: (tx: Transaction) => Promise<T>): Promise<T> => {
    let out!: T;
    let failure: unknown = null;
    await db
      .transaction(async (tx) => {
        if (actor.kind === "anon") {
          await tx.exec("set local role anon");
          await tx.query("select set_config('request.jwt.claims', '{}', true)");
        } else if (actor.kind === "service") {
          await tx.exec("set local role service_role");
          await tx.query("select set_config('request.jwt.claims', '{}', true)");
        } else {
          await tx.exec("set local role authenticated");
          await tx.query("select set_config('request.jwt.claims', $1, true)", [
            JSON.stringify({ sub: actor.id, role: "authenticated" }),
          ]);
        }
        try {
          out = await fn(tx);
        } catch (e) {
          failure = e;
        }
        // Never let a test's writes leak into the next assertion.
        await tx.rollback();
      })
      .catch(() => {});
    if (failure) throw failure;
    return out;
  };

  const createUser: TestDb["createUser"] = async (opts = {}) => {
    const id = randomUUID();
    await sql("insert into auth.users (id, email) values ($1, $2)", [
      id,
      opts.email ?? `${id.slice(0, 8)}@test.local`,
    ]);
    await sql("update profiles set approved = $2, role = $3 where id = $1", [
      id,
      opts.approved ?? true,
      opts.role ?? "user",
    ]);
    return id;
  };

  return { db, as, createUser, sql };
}

/** Run a statement as an actor and report whether it was rejected. */
export async function rejects(
  t: TestDb,
  actor: Actor,
  query: string,
  params: unknown[] = []
): Promise<boolean> {
  try {
    await t.as(actor, (tx) => tx.query(query, params));
    return false;
  } catch {
    return true;
  }
}

/**
 * Was a write refused? RLS refuses in TWO different ways and both count:
 *   - USING filters the target row out, so the statement affects 0 rows;
 *   - WITH CHECK rejects the new row, so the statement THROWS.
 * Treating a throw as a test failure would report a correctly-refused write
 * as a vulnerability.
 */
export async function blocked(
  t: TestDb,
  actor: Actor,
  query: string,
  params: unknown[] = []
): Promise<boolean> {
  try {
    const n = await t.as(actor, async (tx) => (await tx.query(query, params)).affectedRows ?? 0);
    return n === 0;
  } catch (e) {
    if (/row-level security|permission denied/i.test((e as Error).message)) return true;
    throw e;
  }
}

/** Rows affected by an UPDATE/DELETE as an actor (RLS filters silently to 0). */
export async function affected(
  t: TestDb,
  actor: Actor,
  query: string,
  params: unknown[] = []
): Promise<number> {
  return t.as(actor, async (tx) => (await tx.query(query, params)).affectedRows ?? 0);
}

/**
 * Can an actor read ANY row? Either refusal counts as "no": a revoked grant
 * throws permission denied, RLS returns zero rows.
 */
export async function canRead(
  t: TestDb,
  actor: Actor,
  query: string,
  params: unknown[] = []
): Promise<boolean> {
  try {
    return (await t.as(actor, async (tx) => (await tx.query(query, params)).rows.length)) > 0;
  } catch (e) {
    if (/permission denied|row-level security/i.test((e as Error).message)) return false;
    throw e;
  }
}

/** Rows visible to an actor. */
export async function visible(
  t: TestDb,
  actor: Actor,
  query: string,
  params: unknown[] = []
): Promise<number> {
  return t.as(actor, async (tx) => (await tx.query(query, params)).rows.length);
}
