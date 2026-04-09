param(
  [string]$Target = "your-extensions/widgets/gardenbeds-plant-explorer/src/runtime/widget.tsx",
  [switch]$Fix
)

$clientRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$cachePath = Join-Path $PSScriptRoot ".eslintcache"

$arguments = @(
  "eslint",
  "--cache",
  "--cache-location",
  $cachePath,
  $Target
)

if ($Fix) {
  $arguments += "--fix"
}

Push-Location $clientRoot
try {
  & npx @arguments
}
finally {
  Pop-Location
}
