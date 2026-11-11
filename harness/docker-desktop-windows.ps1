# Installs Docker Desktop (WSL2 backend, Linux containers) on a hosted Windows Server runner, which Docker doesn't
# support but which works once the runner's own Moby service is stopped. Adapted from visual-check/host-ci-probe.
$ErrorActionPreference = 'Continue'
$t = [Diagnostics.Stopwatch]::StartNew()
function At { "at $([math]::Round($t.Elapsed.TotalSeconds)) s" }
$installer = "$env:RUNNER_TEMP\DockerDesktopInstaller.exe"
Invoke-WebRequest -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $installer
Write-Output "downloaded $((Get-Item $installer).Length) bytes $(At)"
$p = Start-Process $installer -ArgumentList 'install', '--quiet', '--accept-license', '--backend=wsl-2', '--always-run-service' -PassThru
if (-not $p.WaitForExit(900000)) { Write-Output "installer still running after 15 min"; $p.Kill() }
Write-Output "installer exit $($p.ExitCode) $(At)"
# The runner's own Moby service holds \\.\pipe\docker_engine, which Docker Desktop's API proxy needs
Stop-Service docker -Force -ErrorAction Continue
Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe' -ErrorAction Continue
$cli = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
for ($i = 0; $i -lt 120; $i++) { & $cli --context desktop-linux info *> $null; if (-not $LASTEXITCODE) { break }; Start-Sleep 5 }
Write-Output "engine up $(At)"
& $cli --context desktop-linux version --format '{{.Client.Version}} / {{.Server.Version}}' 2>&1 | Write-Output
& $cli --context desktop-linux info --format '{{.OperatingSystem}} | {{.OSType}} | {{.KernelVersion}} | {{.NCPU}} CPUs | {{.MemTotal}} | {{.Driver}} | {{json .DriverStatus}}' 2>&1 | Write-Output
(wsl.exe -l -v | Out-String) -replace "`0", '' | Write-Output
& $cli --context desktop-linux info *> $null
if ($LASTEXITCODE) { throw 'Docker Desktop: no Linux engine' }
