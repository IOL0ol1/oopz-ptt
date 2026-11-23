# 构建全部产物到 dist/
#   OopzPtt.exe                  本地助手（Native AOT，单文件）
#   oopz-ptt-extension.zip       浏览器扩展
#   oopz-ptt.user.js             油猴脚本
#   OopzPtt-<版本>-win-x64.zip   以上三者打包
param(
    [string]$Version
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Version) { $Version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim() }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版本号格式应为 x.y.z：$Version" }
Write-Host "版本 $Version"

$dist = Join-Path $root 'dist'
if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
New-Item -ItemType Directory $dist | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding $false

# Native AOT 链接时要用 vswhere 找 MSVC，本机 PATH 里不一定有
$installer = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer'
if ((Test-Path (Join-Path $installer 'vswhere.exe')) -and ($env:PATH -notlike "*$installer*")) {
    $env:PATH = "$installer;$env:PATH"
}

# 1. 本地助手
$hostOut = Join-Path $dist 'host'
dotnet publish (Join-Path $root 'host/OopzPtt.csproj') -c Release -r win-x64 -o $hostOut "-p:Version=$Version"
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish 失败' }
Copy-Item (Join-Path $hostOut 'OopzPtt.exe') $dist
Remove-Item $hostOut -Recurse -Force

# 2. 页面脚本（写入版本号）
$pageSrc = [System.IO.File]::ReadAllText((Join-Path $root 'extension/oopz-ptt.js'), $utf8)
$pageJs = $pageSrc -replace "const VERSION = '[^']*';", "const VERSION = '$Version';"
if ($pageJs -eq $pageSrc -and $pageSrc -notmatch "const VERSION = '$Version';") { throw '未找到 VERSION 常量' }

# 3. 扩展
$ext = Join-Path $dist 'extension'
Copy-Item (Join-Path $root 'extension') $ext -Recurse
[System.IO.File]::WriteAllText((Join-Path $ext 'oopz-ptt.js'), $pageJs, $utf8)
$manifestPath = Join-Path $ext 'manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath, $utf8) -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`""
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8)
Compress-Archive -Path (Join-Path $ext '*') -DestinationPath (Join-Path $dist 'oopz-ptt-extension.zip')

# 4. 油猴脚本：页面直接连接本地助手
$userJs = $pageJs -replace "const TRANSPORT = 'bridge';", "const TRANSPORT = 'ws';"
if ($userJs -eq $pageJs) { throw '未找到 TRANSPORT 常量' }
$header = [System.IO.File]::ReadAllText((Join-Path $root 'userscript/header.js'), $utf8) -replace '(// @version\s+)\S+', "`${1}$Version"
# @icon 写的是 extension/ 下的图标文件名，内嵌成 data URI，与扩展用同一份图标，也不依赖外链
$iconMatch = [regex]::Match($header, '// @icon\s+(\S+\.png)')
if (-not $iconMatch.Success) { throw '未找到 @icon' }
$iconFile = $iconMatch.Groups[1]
$iconB64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Join-Path $root "extension/$($iconFile.Value)")))
$header = $header.Remove($iconFile.Index, $iconFile.Length).Insert($iconFile.Index, "data:image/png;base64,$iconB64")
[System.IO.File]::WriteAllText((Join-Path $dist 'oopz-ptt.user.js'), $header + "`n" + $userJs, $utf8)

# 5. 打包
$pkgName = "OopzPtt-$Version-win-x64"
$pkg = Join-Path $dist $pkgName
New-Item -ItemType Directory $pkg | Out-Null
Copy-Item (Join-Path $dist 'OopzPtt.exe'), (Join-Path $dist 'oopz-ptt.user.js') $pkg
Copy-Item $ext (Join-Path $pkg 'extension') -Recurse
Copy-Item (Join-Path $root 'README.md'), (Join-Path $root 'LICENSE') $pkg
Compress-Archive -Path (Join-Path $pkg '*') -DestinationPath (Join-Path $dist "$pkgName.zip")
Remove-Item $pkg -Recurse -Force

Get-ChildItem $dist -File | ForEach-Object { '{0,-36} {1,10:N0} bytes' -f $_.Name, $_.Length }
