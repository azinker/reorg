param([Parameter(Mandatory=$true)][string]$Script, [string[]]$Args = @())
$envFile = Join-Path $PSScriptRoot "..\.env.prod"
if (-not (Test-Path $envFile)) { Write-Error ".env.prod not found at $envFile"; exit 1 }
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*"?(.*?)"?\s*$') {
    $n = $Matches[1]; $v = $Matches[2]
    Set-Item -Path "env:$n" -Value $v
  }
}
$host1 = ($env:DATABASE_URL -replace '.*@', '' -replace '\..*', '')
Write-Host "Loaded .env.prod. DATABASE_URL host: $host1"
if ($host1 -notmatch 'little-fire') {
  Write-Warning "Expected prod host 'ep-little-fire-*' but got '$host1'. Proceeding anyway."
}
& npx tsx $Script @Args
