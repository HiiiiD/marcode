# Launches a VS Code Extension Development Host for this repo.
#
# Why this exists: pressing F5 launches the dev host from inside VS Code's own
# extension host, which runs as Code.exe with ELECTRON_RUN_AS_NODE=1. That
# variable makes Electron behave as plain Node, so an inheriting window exits
# immediately instead of opening. This script clears the inherited variables and
# launches a separate instance with its own profile.
#
# Keep this file ASCII-only: PowerShell may read it as ANSI, and non-ASCII
# characters then break parsing.
#
# Usage:
#   yarn dev           # launch with a dedicated dev profile
#   yarn dev:clean     # also pass --disable-extensions

param(
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'

if (-not (Test-Path $exe)) {
    $cmd = Get-Command code -ErrorAction SilentlyContinue
    if ($cmd) {
        # bin\code.cmd -> ..\Code.exe
        $exe = Join-Path (Split-Path -Parent (Split-Path -Parent $cmd.Source)) 'Code.exe'
    }
}
if (-not (Test-Path $exe)) {
    Write-Error "Could not find Code.exe. Set the path at the top of this script."
}

# Every ELECTRON_* / VSCODE_* variable leaks in from the parent extension host
# and can break the launch. A literal list goes stale with each VS Code
# release -- 1.127 added VSCODE_ESM_ENTRYPOINT, which boots the child as an
# extension host even after ELECTRON_RUN_AS_NODE is cleared. Match the shape
# instead of naming the members.
Get-ChildItem Env: |
    Where-Object { $_.Name -match '^(ELECTRON|VSCODE)_' } |
    ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }

# Deliberately outside the repo: VS Code opens and file-watches $repo, and a
# profile directory living inside the watched folder makes the instance exit
# before it opens a window.
$profileDir = Join-Path $env:TEMP 'hiiiid-devhost'

$launchArgs = @(
    "--extensionDevelopmentPath=$repo",
    "--user-data-dir=$profileDir",
    $repo
)
if ($Clean) { $launchArgs += '--disable-extensions' }

Write-Host "Launching dev host..."
Write-Host "  code    : $exe"
Write-Host "  profile : $profileDir"

Start-Process -FilePath $exe -ArgumentList $launchArgs

Start-Sleep -Seconds 4
if (Test-Path $profileDir) {
    Write-Host "Dev host started."
} else {
    Write-Warning "Profile directory was not created; the instance may have exited immediately."
}
