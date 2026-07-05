# DENBA backup pull: Pi -> OneDrive (run daily by Task Scheduler)
$od = $env:OneDrive
if (-not $od) { $od = (Get-ItemProperty 'HKCU:\Environment' -Name OneDrive -ErrorAction SilentlyContinue).OneDrive }
if (-not $od -or -not (Test-Path $od)) { exit 1 }
$dest = Join-Path $od 'DENBA-Backup'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
& "$env:SystemRoot\System32\OpenSSH\scp.exe" -o BatchMode=yes -q 'root@<pi-ip>:/opt/denba/backups/*' $dest
exit $LASTEXITCODE
