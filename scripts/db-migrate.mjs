// Applies supabase/migrations/*.sql to the database in DATABASE_URL, recording each
// in supabase_migrations.schema_migrations (so the Supabase CLI/dashboard see them as
// applied). Each migration runs atomically; already-applied versions are skipped, so
// it is safe to run repeatedly. An optional supabase/seed/seed.sql runs at the end.
//
// Modes:
//   (default)    apply pending migrations, then seed if present
//   BASELINE=1   record every current migration file as already-applied WITHOUT
//                executing it — one-time adoption of a database that was migrated by
//                hand, so future runs apply only genuinely new migrations.
//
// Usage: DATABASE_URL=... node scripts/db-migrate.mjs
//        DATABASE_URL=... BASELINE=1 node scripts/db-migrate.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const migDir = join(root, 'supabase', 'migrations');
const url = process.env.DATABASE_URL;
const baseline = process.env.BASELINE === '1';
if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
const q = (sql, params) => client.query(sql, params);

const versionOf = (file) => (file.match(/^(\d+)/)?.[1] ?? file.replace(/\.sql$/, ''));
const nameOf = (file) => file.replace(/^\d+[-_]?/, '').replace(/\.sql$/, '');

async function main() {
  await client.connect();
  await q('create schema if not exists supabase_migrations');
  await q(
    'create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)',
  );
  const applied = new Set(
    (await q('select version from supabase_migrations.schema_migrations')).rows.map((r) => r.version),
  );

  const files = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();

  if (baseline) {
    let recorded = 0;
    for (const f of files) {
      const version = versionOf(f);
      if (applied.has(version)) {
        console.log(`have   ${f}`);
        continue;
      }
      await q(
        'insert into supabase_migrations.schema_migrations (version, name) values ($1, $2) on conflict do nothing',
        [version, nameOf(f)],
      );
      console.log(`mark   ${f} (recorded as already-applied, NOT executed)`);
      recorded++;
    }
    await client.end();
    console.log(`\nBASELINE COMPLETE — ${recorded} migration(s) recorded, 0 executed.`);
    return;
  }

  let count = 0;
  for (const f of files) {
    const version = versionOf(f);
    if (applied.has(version)) {
      console.log(`skip   ${f} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migDir, f), 'utf8');
    process.stdout.write(`apply  ${f} ... `);
    try {
      await q('begin');
      await q(sql);
      await q('insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)', [
        version,
        nameOf(f),
      ]);
      await q('commit');
      console.log('OK');
      count++;
    } catch (e) {
      await q('rollback').catch(() => {});
      console.error('FAILED\n  ' + e.message);
      await client.end();
      process.exit(1);
    }
  }

  const seedPath = join(root, 'supabase', 'seed', 'seed.sql');
  if (existsSync(seedPath)) {
    process.stdout.write('apply  seed.sql ... ');
    try {
      await q('begin');
      await q(readFileSync(seedPath, 'utf8'));
      await q('commit');
      console.log('OK');
    } catch (e) {
      await q('rollback').catch(() => {});
      console.error('SEED FAILED\n  ' + e.message);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log(`\nDONE — ${count} new migration(s) applied.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
