param([Parameter(Mandatory=$true)][string]$SqlFile)
# WRITE-CAPABLE query against PRODUCTION (read_only = false).
#
# Only with the operator's explicit go-ahead for that specific change, and only after a
# dry run: a DO block that makes the change, measures it and ends in RAISE EXCEPTION, so
# everything rolls back (see README.md). Re-read with query_ro.ps1 afterwards to confirm
# the dry run left nothing behind, then apply for real.
$token = [Environment]::GetEnvironmentVariable('SUPABASE_ACCESS_TOKEN', 'User')
if (-not $token) { throw 'SUPABASE_ACCESS_TOKEN (User scope) is empty' }
$sql = [System.IO.File]::ReadAllText((Resolve-Path $SqlFile).Path, [System.Text.Encoding]::UTF8)
$body = @{ query = $sql; read_only = $false } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method Post `
    -Uri 'https://api.supabase.com/v1/projects/bxaovkzemfyxrxbcqask/database/query' `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json; charset=utf-8' -Body $bytes
  $text = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
  "HTTP $($r.StatusCode): $text"
} catch {
  "HTTP error: $($_.Exception.Message)"
  if ($_.ErrorDetails) { $_.ErrorDetails.Message }
}
