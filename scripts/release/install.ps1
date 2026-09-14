[CmdletBinding()]
param(
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'

function Require-Command {
    param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)][string]$InstallUrl)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "$Name is required. Install it from $InstallUrl"
    }
}

function Invoke-RequiredPython {
    $candidates = @()
    if ($env:AUTOPROMPT_PYTHON) { $candidates += $env:AUTOPROMPT_PYTHON }
    else { $candidates += @('python', 'python3') }
    foreach ($candidate in $candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $command) { continue }
        & $command.Source -c "import sys, yaml; assert sys.version_info >= (3, 11)"
        if ($LASTEXITCODE -eq 0) { return $command.Source }
    }
    throw 'Python 3.11 or newer with PyYAML is required. Run: python -m pip install PyYAML'
}

Require-Command -Name 'node' -InstallUrl 'https://nodejs.org/en/download'
Require-Command -Name 'npm' -InstallUrl 'https://nodejs.org/en/download'
$pythonExecutable = Invoke-RequiredPython

$nodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required. Found $(& node --version)."
}

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundled = @(Get-ChildItem -LiteralPath $scriptDirectory -Filter 'autoprompt-skill-*.tgz' -File)
if ($bundled.Count -gt 1) {
    throw 'The release kit contains more than one npm archive.'
}

$package = if ($bundled.Count -eq 1) { $bundled[0].FullName } else { 'autoprompt-skill' }
Write-Host "Installing Autoprompt skill from $package"
& npm install --global --ignore-scripts --no-audit --no-fund $package
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed with exit code $LASTEXITCODE."
}

# Resolve the package just installed by npm, not a competing PATH command.
$globalModules = @(& npm root --global)
if ($LASTEXITCODE -ne 0 -or $globalModules.Count -ne 1 -or -not $globalModules[0].Trim()) {
    throw 'Could not resolve the installed npm package root.'
}
$installedCli = Join-Path $globalModules[0].Trim() 'autoprompt-skill/bin/autoprompt.cjs'
if (-not (Test-Path -LiteralPath $installedCli -PathType Leaf)) {
    throw "Installed Autoprompt entrypoint is missing: $installedCli"
}
$installedVersion = & node $installedCli version
if ($LASTEXITCODE -ne 0) { throw 'The newly installed Autoprompt entrypoint failed.' }

Write-Host "Installed Autoprompt skill $installedVersion."
if (-not $NoLaunch -and [Environment]::UserInteractive) {
    & node $installedCli
    exit $LASTEXITCODE
}

$quotedCli = $installedCli.Replace("'", "''")
Write-Host "Open this provider installer with: node '$quotedCli'"
