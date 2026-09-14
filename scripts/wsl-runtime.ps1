[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('import','resume')][string]$Action,
  [Parameter(Mandatory=$true)][string]$WslExe,
  [Parameter(Mandatory=$true)][ValidatePattern('^apwsl-[a-f0-9]{16}$')][string]$Distribution,
  [Parameter(Mandatory=$true)][string]$InstallDirectory,
  [Parameter(Mandatory=$true)][string]$Rootfs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-PhysicalFile([string]$PathValue) {
  $item = Get-Item -LiteralPath $PathValue -Force
  if (-not $item.PSIsContainer -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) { return $item.FullName }
  throw "Expected a physical regular file: $PathValue"
}
function Assert-PhysicalDirectory([string]$PathValue) {
  $item = Get-Item -LiteralPath $PathValue -Force
  if ($item.PSIsContainer -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)) { return $item.FullName }
  throw "Expected a physical directory: $PathValue"
}
function Invoke-WslCaptured([string[]]$Arguments) {
  # Windows PowerShell 5.1 promotes native stderr records to PowerShell errors.
  # WSL writes ordinary progress and success text to stderr, so capture it with
  # Continue semantics and decide success only from the native exit code.
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $global:LASTEXITCODE = 0
    $output = @(& $script:resolvedWsl @Arguments 2>&1)
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  return [pscustomobject]@{Code=$code;Output=$output}
}

$resolvedWsl = Assert-PhysicalFile $WslExe
$resolvedRootfs = Assert-PhysicalFile $Rootfs
$parent = Split-Path -Parent $InstallDirectory
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'The private WSL install parent is unavailable' }
$listResult = Invoke-WslCaptured -Arguments @('--list','--quiet')
if ($listResult.Code -ne 0) { throw "wsl.exe --list failed with exit code $($listResult.Code)" }
$listed = @($listResult.Output)
$present = @($listed | ForEach-Object { ([string]$_).Replace([string][char]0,'').Trim() } | Where-Object { $_ -ceq $Distribution }).Count -eq 1

if ($Action -eq 'import' -or ($Action -eq 'resume' -and -not $present -and -not (Test-Path -LiteralPath $InstallDirectory))) {
  if ($present -or (Test-Path -LiteralPath $InstallDirectory)) { throw 'The dedicated WSL distribution or install directory already exists' }
  New-Item -ItemType Directory -Path $InstallDirectory | Out-Null
  $importResult = Invoke-WslCaptured -Arguments @('--import',$Distribution,$InstallDirectory,$resolvedRootfs,'--version','2')
  if ($importResult.Code -ne 0) {
    Remove-Item -LiteralPath $InstallDirectory -Force -Recurse -ErrorAction SilentlyContinue
    throw "wsl.exe --import failed with exit code $($importResult.Code): $($importResult.Output -join ' ')"
  }
} elseif (-not $present -or -not (Test-Path -LiteralPath $InstallDirectory -PathType Container)) {
  throw 'The configured WSL distribution and private install directory do not agree'
}

$resolvedInstall = Assert-PhysicalDirectory $InstallDirectory
$verifyResult = Invoke-WslCaptured -Arguments @('--list','--quiet')
$verified = @($verifyResult.Output)
if ($verifyResult.Code -ne 0 -or @($verified | ForEach-Object { ([string]$_).Replace([string][char]0,'').Trim() } | Where-Object { $_ -ceq $Distribution }).Count -ne 1) {
  throw 'The dedicated WSL distribution could not be verified after import'
}
[pscustomobject]@{schemaVersion=1;status='IMPORTED';distribution=$Distribution;installDirectory=$resolvedInstall}|ConvertTo-Json -Compress
