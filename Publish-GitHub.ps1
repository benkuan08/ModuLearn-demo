[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9_.-]+$')]
    [string]$Repository = 'ModuLearn-demo'
)

# Run git credential-manager github login yourself first if authentication is needed.
# This pushes an existing repository. No credential parsing or repository API calls.
$ErrorActionPreference = 'Stop'
$branch = 'main'
$repoUrl = 'https://github.com/benkuan08/' + $Repository + '.git'
$oldLocation = Get-Location

try {
    Set-Location -LiteralPath $PSScriptRoot
    & git --version
    if ($LASTEXITCODE -ne 0) { throw 'Git is not available on PATH.' }
    if (-not (Test-Path -LiteralPath '.git')) {
        & git init -b $branch
        if ($LASTEXITCODE -ne 0) { throw 'Git initialization failed.' }
    }
    & git add -A
    if ($LASTEXITCODE -ne 0) { throw 'Could not stage the project files.' }
    $status = & git status --porcelain
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the project changes.' }
    if (-not [string]::IsNullOrWhiteSpace(($status -join "`n"))) {
        & git commit -m 'feat: add Colab notebook for the syllabus-wide tutor'
        if ($LASTEXITCODE -ne 0) { throw 'The project commit failed.' }
    } else {
        Write-Host 'No changes to commit.'
    }
    & git branch -M $branch
    if ($LASTEXITCODE -ne 0) { throw 'Could not select the publishing branch.' }
    $existing = & git remote
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect Git remotes.' }
    if ($existing -contains 'origin') { & git remote set-url origin $repoUrl }
    else { & git remote add origin $repoUrl }
    if ($LASTEXITCODE -ne 0) { throw 'Could not configure the GitHub remote.' }
    Write-Host ('Pushing to ' + $repoUrl)
    & git push -u origin $branch
    if ($LASTEXITCODE -ne 0) { throw 'Git push failed. No success was reported and no force-push was attempted.' }
    $localCommit = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the local commit.' }
    $remoteLine = & git ls-remote origin ('refs/heads/' + $branch)
    if ($LASTEXITCODE -ne 0 -or -not $remoteLine -or ($remoteLine -split '\s+')[0] -ne $localCommit) {
        throw 'The push returned, but the remote commit could not be verified.'
    }
    Write-Host ('Verified commit: ' + $localCommit)
    Write-Host ('Colab: https://colab.research.google.com/github/benkuan08/' + $Repository + '/blob/main/notebooks/modulearn-colab.ipynb')
} finally {
    Set-Location -LiteralPath $oldLocation.Path
}
