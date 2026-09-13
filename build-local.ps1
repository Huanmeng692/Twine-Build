#requires -version 5.1
<#
    本地构建 Twine 作品为 Android APK。

    用法（在 PowerShell 里执行）：
        cd D:\Workbuddy\Twine-Build
        .\build-local.ps1

    只重新打包、不重新同步 web 资源：
        .\build-local.ps1 -SkipSync

    若提示禁止运行脚本，先执行一次：
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#>
[CmdletBinding()]
param(
    [switch]$SkipSync
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host ('==> ' + $Text) -ForegroundColor Cyan
}

function Stop-Build {
    param([string]$Text)
    Write-Host ''
    Write-Host ('构建中止: ' + $Text) -ForegroundColor Red
    exit 1
}

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { $nodeExe = 'D:\APP\NodeJs\node.exe' }
if (-not (Test-Path $nodeExe)) { Stop-Build '找不到 node.exe，请确认 Node 已安装。' }

$npmCli = Join-Path (Split-Path $nodeExe) 'node_modules\npm\bin\npm-cli.js'
if (-not (Test-Path $npmCli)) { Stop-Build ('找不到 npm-cli.js: ' + $npmCli) }

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = 'D:\APP\JDK21' }
if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = 'D:\APP\Android\Sdk' }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

if (-not (Test-Path (Join-Path $env:JAVA_HOME 'bin\java.exe'))) {
    Stop-Build ('JAVA_HOME 无效: ' + $env:JAVA_HOME)
}
if (-not (Test-Path $env:ANDROID_HOME)) {
    Stop-Build ('ANDROID_HOME 无效: ' + $env:ANDROID_HOME)
}
if (-not (Test-Path 'node_modules')) {
    Stop-Build ('缺少 node_modules，请先运行: node "' + $npmCli + '" ci')
}

Write-Host ('Node      : ' + $nodeExe)
Write-Host ('JAVA_HOME : ' + $env:JAVA_HOME)
Write-Host ('SDK       : ' + $env:ANDROID_HOME)

Write-Step '生成 dist-web'
& $nodeExe 'builder\prepare.mjs'
if ($LASTEXITCODE -ne 0) { Stop-Build 'prepare.mjs 执行失败。' }

if (-not $SkipSync) {
    if (-not (Test-Path 'android')) {
        Write-Step '首次构建，生成 Android 工程'
        & $nodeExe $npmCli run android:init
        if ($LASTEXITCODE -ne 0) { Stop-Build 'cap add android 失败。' }
        & $nodeExe 'builder\configure-android.mjs'
        if ($LASTEXITCODE -ne 0) { Stop-Build 'configure-android.mjs 失败。' }
    }
    else {
        Write-Step '同步 web 资源到 Android 工程'
        & $nodeExe $npmCli run android:sync
        if ($LASTEXITCODE -ne 0) { Stop-Build 'android:sync 失败。' }
    }
}

Write-Step '构建 debug APK（首次较慢，之后走缓存）'
Push-Location 'android'
try {
    & '.\gradlew.bat' assembleDebug
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
if ($code -ne 0) { Stop-Build 'Gradle 构建失败，请查看上方日志。' }

$source = 'android\app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $source)) { Stop-Build ('未找到构建产物: ' + $source) }

Write-Step '归档 APK'
$targetDir = 'release\apk'
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
$target = Join-Path $targetDir 'app-debug.apk'
Copy-Item $source $target -Force

$hash = (Get-FileHash $source -Algorithm SHA256).Hash.ToLower()
Set-Content -Path (Join-Path $targetDir 'SHA256SUMS.txt') -Value ($hash + '  app-debug.apk') -NoNewline

$sizeMB = [math]::Round((Get-Item $source).Length / 1MB, 2)

Write-Host ''
Write-Host '构建完成' -ForegroundColor Green
Write-Host ('  产物    : ' + $target + '  (' + $sizeMB + ' MB)')
Write-Host ('  SHA-256 : ' + $hash)
Write-Host ''
Write-Host '把 APK 传到手机安装即可（需允许安装未知来源应用）。'
