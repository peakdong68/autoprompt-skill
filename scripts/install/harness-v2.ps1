# Private v2 package routing shared by the public PowerShell entrypoints.
function Test-HarnessV2Provider {
    param([string]$Client)
    return $Client -cin @('claude','opencode','kilo','vscode','prime','omp','deepseek','hermes','grok')
}
function Get-HarnessV2Root {
    param([string]$Client)
    $root = & node -e 'process.stdout.write(require(process.argv[1]).resolveRoot(process.argv[2]))' (Join-Path $RepoRoot 'scripts/harness-v2-package.cjs') $Client
    if ($LASTEXITCODE -ne 0) { throw "Invalid v2 config root for $Client" }
    return [string]$root
}
function Install-HarnessV2Lifecycle {
    param([string]$Client)
    try {
        $root = Get-HarnessV2Root -Client $Client
        & node (Join-Path $RepoRoot 'scripts/harness-v2-package.cjs') install $Client --root $root
        if ($LASTEXITCODE -ne 0) { throw 'Private v2 lifecycle failed' }
        $script:ResultRows += "RESULT=PASS client=$Client dest=$root format=private-v2"
    } catch {
        [Console]::Error.WriteLine($_)
        $script:ResultRows += "RESULT=FAIL client=$Client stage=lifecycle"
        $script:AnyFail = 1
    }
}
function Uninstall-HarnessV2Lifecycle {
    param([string]$Client)
    try {
        $root = Get-HarnessV2Root -Client $Client
        $output = @(& node (Join-Path $RepoRoot 'scripts/harness-v2-package.cjs') uninstall $Client --root $root)
        if ($LASTEXITCODE -ne 0) { throw 'Private v2 lifecycle failed' }
        if ($output.Count -ne 1) { throw 'Private v2 lifecycle returned an invalid result' }
        $result = $output[0] | ConvertFrom-Json -ErrorAction Stop
        if ($result.status -ceq 'uninstalled') {
            $script:ResultRows += "RESULT=OK client=$Client removed=private-v2"
        } elseif ($result.status -ceq 'not-installed') {
            $script:ResultRows += "SKIP=skip client=$Client reason=no-receipt"
        } else {
            throw 'Private v2 lifecycle returned an unknown uninstall status'
        }
    } catch {
        [Console]::Error.WriteLine($_)
        $script:ResultRows += "RESULT=FAIL client=$Client code=1"
        $script:UninstallExitCode = 1
    }
}
function Get-HarnessV2Status {
    param([string]$Client)
    $det = Invoke-LibCapture -Call { Detect-Client -Name $Client }
    $detected = if ($det.Code -eq 0) { 'yes' } else { 'no' }
    $version = if ($det.Code -eq 0) { $det.Record -replace '^.*version=', '' } else { '-' }
    $installed = 'no'; $verifies = 'no'; $reason = 'not-installed'
    try {
        $root = Get-HarnessV2Root -Client $Client
        if (Test-Path -LiteralPath (Join-Path $root ".autoprompt-$Client-v2.json")) {
            $installed = 'yes'
            & node (Join-Path $RepoRoot 'scripts/harness-v2-package.cjs') doctor $Client --root $root *> $null
            if ($LASTEXITCODE -eq 0) { $verifies = 'yes'; $reason = '-' }
            else { $reason = 'payload-invalid' }
        }
    } catch { $reason = 'invalid-root' }
    return @{ Detected = $detected; Installed = $installed; Verifies = $verifies; Version = $version; Reason = $reason; Extras = $(if ($verifies -ceq 'yes') { 'complete' } else { 'missing' }); Mode = '-'; Support = 'degraded'; Activation = 'attestation-required' }
}
