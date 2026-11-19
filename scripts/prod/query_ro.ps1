param([Parameter(Mandatory=$true)][string]$SqlFile)
# READ-ONLY query against PRODUCTION through the Management API. read_only is hard-coded,
# so Postgres refuses any write. The operator allows these without asking.
# Token: the Windows User-scope variable SUPABASE_ACCESS_TOKEN (a running session keeps the
# value it started with, so this reads the User scope directly).
$token = [Environment]::GetEnvironmentVariable('SUPABASE_ACCESS_TOKEN', 'User')
if (-not $token) { throw 'SUPABASE_ACCESS_TOKEN (User scope) is empty' }
$sql = [System.IO.File]::ReadAllText((Resolve-Path $SqlFile).Path, [System.Text.Encoding]::UTF8)
$body = @{ query = $sql; read_only = $true } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method Post `
    -Uri 'https://api.supabase.com/v1/projects/bxaovkzemfyxrxbcqask/database/query' `
    -Headers @{ Authorization = "Bearer $token" } `
    -ContentType 'application/json; charset=utf-8' -Body $bytes
  $text = [System.Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
  $text | ConvertFrom-Json | Format-List | Out-String -Width 250
} catch {
  "HTTP error: $($_.Exception.Message)"
  if ($_.ErrorDetails) { $_.ErrorDetails.Message }
}
