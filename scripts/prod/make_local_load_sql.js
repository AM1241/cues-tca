// Builds load.sql for the LOCAL docker database from snapshot/*.json.
// Usage: node make_local_load_sql.js <snapshotDir> <outFile>
const fs = require('fs')
const path = require('path')
const [dir, out] = process.argv.slice(2)
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
const tables = files.map((f) => f.replace(/\.json$/, ''))
const tag = '$snap_9f2c$'
let sql = `\\set ON_ERROR_STOP on
begin;
set session_replication_role = replica;
create function pg_temp.load_snapshot(t text, j json) returns int language plpgsql as $f$
declare cols text; n int;
begin
  select string_agg(quote_ident(column_name), ',' order by ordinal_position) into cols
  from information_schema.columns
  where table_schema = 'public' and table_name = t and is_generated = 'NEVER';
  execute format('insert into public.%I (%s) select %s from json_populate_recordset(null::public.%I, $1)', t, cols, cols, t) using j;
  get diagnostics n = row_count;
  return n;
end $f$;
truncate ${tables.map((t) => 'public.' + t).join(', ')} cascade;
`
for (const t of tables) {
  const j = fs.readFileSync(path.join(dir, t + '.json'), 'utf8')
  if (j.includes(tag)) throw new Error('tag collision in ' + t)
  sql += `select '${t}' as tbl, pg_temp.load_snapshot('${t}', ${tag}${j}${tag}::json) as rows;\n`
}
sql += 'commit;\n'
fs.writeFileSync(out, sql, 'utf8')
console.log('tables:', tables.length, 'bytes:', sql.length)
