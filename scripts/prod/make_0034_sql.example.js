// Builds two files from the committed migration:
//   dry_0034.sql   — one DO block that applies 0034, measures, and RAISES (rolls back)
//   apply_0034.sql — the migration plus its schema_migrations row, in one transaction
const fs = require('fs')
const [migPath, outDir] = process.argv.slice(2)
const mig = fs.readFileSync(migPath, 'utf8').replace(/\r\n/g, '\n')

const body = mig.split('\n').filter((l) => !l.startsWith('--')).join('\n')
const stmts = body.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)
if (stmts.length !== 2) throw new Error('expected 2 statements, got ' + stmts.length)
for (const s of stmts) if (s.includes('$m$')) throw new Error('tag collision')
const exec = stmts.map((s) => `  execute $m$${s}$m$;`).join('\n')

const dry = `do $dry$
declare
  v_hash_before text; v_hash_after text; v_rows int; v_nulls int;
  v_fr text; v_it text; v_null text; v_priv text; v_comment text;
begin
  v_hash_before := public.scoring_hash_of_snapshot(public.scoring_config_snapshot());

${exec}

  v_hash_after := public.scoring_hash_of_snapshot(public.scoring_config_snapshot());

  execute $q$select count(*), count(*) filter (where output_language is null) from public.configurations$q$
    into v_rows, v_nulls;

  begin
    execute $q$update public.configurations set output_language = 'fr'$q$;
    v_fr := 'fr ACCEPTED';
  exception when check_violation then v_fr := 'fr rejected';
  end;
  begin
    execute $q$update public.configurations set output_language = 'it'$q$;
    v_it := 'it accepted';
  exception when others then v_it := 'it FAILED: ' || sqlerrm;
  end;
  begin
    execute $q$update public.configurations set output_language = null$q$;
    v_null := 'null accepted';
  exception when others then v_null := 'null FAILED: ' || sqlerrm;
  end;

  select format('authenticated update=%s',
    has_column_privilege('authenticated', 'public.configurations', 'output_language', 'update')) into v_priv;
  select col_description('public.configurations'::regclass,
    (select attnum from pg_attribute where attrelid = 'public.configurations'::regclass and attname = 'output_language'))
    into v_comment;

  raise exception 'DRY RUN, ROLLED BACK | rows % (null %) | % / % / % | scoring hash unchanged: % | % | comment set: %',
    v_rows, v_nulls, v_fr, v_it, v_null, v_hash_before = v_hash_after, v_priv, v_comment is not null;
end
$dry$;
`

if (mig.includes('$mig$')) throw new Error('tag collision')
const apply = `begin;
${mig}
insert into supabase_migrations.schema_migrations (version, name, statements)
values ('0034', 'output_language', array[$mig$${mig}$mig$]);
commit;
`
fs.writeFileSync(outDir + '/dry_0034.sql', dry)
fs.writeFileSync(outDir + '/apply_0034.sql', apply)
console.log('statements:', stmts.length, '| dry bytes:', dry.length, '| apply bytes:', apply.length)
