$ErrorActionPreference = 'Stop'
$version = (& node --version 2>$null)
if (-not $version) {
  throw '需要安装 Node.js 22.5 或更新版本，然后重新运行本脚本。'
}
$major = [int]($version.TrimStart('v').Split('.')[0])
$minor = [int]($version.TrimStart('v').Split('.')[1])
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 5)) {
  throw "当前 $version 太旧，需要 Node.js 22.5 或更新版本。"
}
if (-not $env:ADMIN_USERNAME) { $env:ADMIN_USERNAME = 'owner' }
if (-not $env:HOST) { $env:HOST = '127.0.0.1' }
if (-not $env:PORT) { $env:PORT = '3000' }
if (-not $env:DB_PATH) { $env:DB_PATH = (Join-Path $PSScriptRoot 'data\banduo.sqlite') }
Set-Location $PSScriptRoot
& node --disable-warning=ExperimentalWarning server.js
