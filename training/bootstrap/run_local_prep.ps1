param(
    [string]$SourceCache = "C:\\EAITmp"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$artifactRoot = Join-Path $PSScriptRoot "artifacts"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

Write-Output "== Enthusia AI local training bootstrap =="
Write-Output "Repository: $repoRoot"
Write-Output "Source cache: $SourceCache"

python (Join-Path $PSScriptRoot "pc_preflight.py") `
  --output (Join-Path $artifactRoot "pc-preflight.json")

python (Join-Path $PSScriptRoot "collect_github_sources.py") `
  --manifest (Join-Path $PSScriptRoot "repositories.json") `
  --workspace $SourceCache `
  --output (Join-Path $artifactRoot "github-source-corpus.jsonl.gz") `
  --summary (Join-Path $artifactRoot "github-source-summary.json") `
  --audit (Join-Path $artifactRoot "github-source-audit.json")

Write-Output ""
Write-Output "Bootstrap complete."
Write-Output "Generated files are git-ignored:"
Write-Output "  $(Join-Path $artifactRoot 'pc-preflight.json')"
Write-Output "  $(Join-Path $artifactRoot 'github-source-corpus.jsonl.gz')"
Write-Output "  $(Join-Path $artifactRoot 'github-source-summary.json')"
Write-Output "  $(Join-Path $artifactRoot 'github-source-audit.json')"
Write-Output ""
Write-Output "Do not start paid training from this script. W16-W20 remain the canonical dataset/training pipeline."
