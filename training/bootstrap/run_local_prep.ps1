param(
    [string]$SourceCache = "C:\\EAITmp"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\\..")).Path
$artifactRoot = Join-Path $PSScriptRoot "artifacts"
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null

Write-Host "== Enthusia AI local training bootstrap =="
Write-Host "Repository: $repoRoot"
Write-Host "Source cache: $SourceCache"

python (Join-Path $PSScriptRoot "pc_preflight.py") `
  --output (Join-Path $artifactRoot "pc-preflight.json")

python (Join-Path $PSScriptRoot "collect_github_sources.py") `
  --manifest (Join-Path $PSScriptRoot "repositories.json") `
  --workspace $SourceCache `
  --output (Join-Path $artifactRoot "github-source-corpus.jsonl.gz") `
  --summary (Join-Path $artifactRoot "github-source-summary.json") `
  --audit (Join-Path $artifactRoot "github-source-audit.json")

Write-Host ""
Write-Host "Bootstrap complete."
Write-Host "Generated files are git-ignored:"
Write-Host "  $(Join-Path $artifactRoot 'pc-preflight.json')"
Write-Host "  $(Join-Path $artifactRoot 'github-source-corpus.jsonl.gz')"
Write-Host "  $(Join-Path $artifactRoot 'github-source-summary.json')"
Write-Host "  $(Join-Path $artifactRoot 'github-source-audit.json')"
Write-Host ""
Write-Host "Do not start paid training from this script. W16-W20 remain the canonical dataset/training pipeline."
