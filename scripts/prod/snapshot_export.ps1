# Reads production tables as JSON (read_only: true) into $OutDir\<table>.json. Writes nothing to production.
param([Parameter(Mandatory=$true)][string]$OutDir)
$tables = @(
  'sources','configurations','scoring_themes','editors',
  'raw_posts','normalized_posts','raw_post_content_changes','ingest_runs','ingest_run_sources',
  'scoring_requests','scoring_results','analyzed_posts','scoring_job_state','scoring_dead_letter',
  'anonymize_results','anonymized_posts_current','anonymize_job_state','anonymize_dead_letter',
  'clustering_runs','clustering_run_posts','clusters','cluster_assignments',
  'cluster_generation_requests','cluster_generation_request_errors','cluster_generation_results','cluster_generation_reviews',
  'editorial_assets','traceability_links','traceability_link_posts','generation_requests','brand_suggestions','slide_image_requests'
)
$token = [Environment]::GetEnvironmentVariable('SUPABASE_ACCESS_TOKEN', 'User')
New-Item -ItemType Directory -Force $OutDir | Out-Null
foreach ($t in $tables) {
  $sql = "select coalesce(json_agg(t), '[]'::json)::text as j from public.$t t"
  $body = [System.Text.Encoding]::UTF8.GetBytes((@{ query = $sql; read_only = $true } | ConvertTo-Json -Compress))
  $r = Invoke-WebRequest -UseBasicParsing -Method Post `
    -Uri 'https://api.supabase.com/v1/projects/bxaovkzemfyxrxbcqask/database/query' `
    -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json; charset=utf-8' -Body $body
  $text = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
  $j = ($text | ConvertFrom-Json)[0].j
  [System.IO.File]::WriteAllText((Join-Path $OutDir "$t.json"), $j, (New-Object System.Text.UTF8Encoding $false))
  "{0,-36} {1,10} bytes" -f $t, $j.Length
}
