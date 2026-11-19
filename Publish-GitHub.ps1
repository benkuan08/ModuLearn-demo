[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'modulearn-adaptive-tutor'
)

$ErrorActionPreference = 'Stop'
$account = 'benkuan08'
$project = $PSScriptRoot
if (-not $project) { throw 'Run this script from its saved project directory.' }
$remoteUrl = 'https://github.com/' + $account + '/' + $Repository + '.git'
$credential = @{}
$headers = @{}
$oldLocation = Get-Location

try {
    Set-Location -LiteralPath $project
    & git --version
    if ($LASTEXITCODE -ne 0) { throw 'Git must be installed and available on PATH.' }
    if (-not (Test-Path -LiteralPath (Join-Path $project '.git'))) {
        & git init -b main
        if ($LASTEXITCODE -ne 0) { throw 'Git initialization failed.' }
    }
    & git add -- .
    if ($LASTEXITCODE -ne 0) { throw 'Could not stage the project files.' }
    & git diff --cached --quiet
    $stagedChanges = $LASTEXITCODE
    if ($stagedChanges -gt 1) { throw 'Could not inspect staged changes.' }
    & git rev-parse --verify HEAD 2>$null | Out-Null
    $hasCommit = $LASTEXITCODE -eq 0
    if (-not $hasCommit -or $stagedChanges -eq 1) {
        & git commit -m 'feat: publish syllabus-wide adaptive tutoring demo'
        if ($LASTEXITCODE -ne 0) { throw 'Commit failed. Check your Git author configuration.' }
    }

    # Standard Git credential-helper protocol. Nothing is printed or saved to a file.
    # Git Credential Manager may ask you to sign in through your normal browser.
    $request = "protocol=https`nhost=github.com`nusername=$account`n`n"
    $credentialLines = $request | & git credential fill
    if ($LASTEXITCODE -ne 0) { throw 'GitHub sign-in was not completed. Sign in with Git Credential Manager and rerun this script.' }
    foreach ($line in $credentialLines) {
        if ($line -match '^([^=]+)=(.*)$') { $credential[$Matches[1]] = $Matches[2] }
    }
    if (-not $credential.password) { throw 'Git did not provide a GitHub credential.' }
    $headers = @{
        Authorization = 'Bearer ' + $credential.password
        Accept = 'application/vnd.github+json'
        'User-Agent' = 'ModuLearn-publisher'
        'X-GitHub-Api-Version' = '2026-03-10'
    }
    $signedIn = Invoke-RestMethod -Uri 'https://api.github.com/user' -Headers $headers -TimeoutSec 30
    if ($signedIn.login -ne $account) { throw ('The credential belongs to ' + $signedIn.login + ', not ' + $account + '. No repository was changed.') }

    $repo = $null
    try {
        $repo = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $account + '/' + $Repository) -Headers $headers -TimeoutSec 30
    } catch {
        if (-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404) { throw }
    }
    if (-not $repo) {
        $body = @{ name = $Repository; private = $false; auto_init = $false; description = 'Whole-syllabus assessment and personalized teaching paths for ModuLearn.' } | ConvertTo-Json
        $repo = Invoke-RestMethod -Method Post -Uri 'https://api.github.com/user/repos' -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
        Write-Host ('Created public repository: ' + $repo.html_url)
    } elseif ($repo.private) {
        throw 'That name is occupied by a private repository. Choose a different repository name; its existing contents have not been made public.'
    }

    & git remote get-url origin 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { & git remote set-url origin $remoteUrl }
    else { & git remote add origin $remoteUrl }
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the GitHub remote.' }
    # Never force-push or overwrite an unrelated repository history.
    & git push -u origin main
    if ($LASTEXITCODE -ne 0) { throw 'Push failed. Existing remote history has not been overwritten.' }
    $localCommit = (& git rev-parse HEAD).Trim()
    $remoteLine = & git ls-remote origin refs/heads/main
    if ($LASTEXITCODE -ne 0 -or -not $remoteLine -or ($remoteLine -split '\s+')[0] -ne $localCommit) { throw 'Could not verify that GitHub received the local commit.' }
    Write-Host ('Verified published commit: ' + $localCommit)
    Write-Host ('Open: ' + $repo.html_url)
    Write-Host 'For the demo, open Code > Codespaces > Create codespace. Follow README.md for the hosted model endpoint and token.'
} finally {
    $credential.Clear()
    $credentialLines = $null
    $headers.Clear()
    Set-Location -LiteralPath $oldLocation.Path
}
