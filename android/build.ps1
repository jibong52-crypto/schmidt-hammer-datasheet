<#
.SYNOPSIS
  슈미트해머 데이터시트 APK 빌드 (Gradle 없이 aapt2 + javac + d8 + apksigner).

.DESCRIPTION
  1) 필요한 도구가 없으면 내려받아 ToolchainDir 에 풀어 둔다 (체크섬 확인).
       · JDK 17                : Eclipse Temurin (Adoptium)           — GPLv2 + Classpath Exception
       · Android build-tools 34 / platform 34 : dl.google.com        — Android SDK 라이선스 적용
                                                (https://developer.android.com/studio/terms)
  2) ..\app (웹앱)을 APK 의 assets\www 로 복사한다 (서버/테스트용 파일은 제외).
  3) 리소스 컴파일/링크 → Java 컴파일 → dex 변환 → APK 합치기 → 정렬 → 서명 → 검증.
  결과: dist\SchmidtDatasheet.apk

  한글이 들어간 경로(예: 사용자 이름)에서는 일부 안드로이드 도구가 실패할 수 있어,
  도구와 작업 폴더는 ASCII 경로(C:\Users\Public\schmidt-android\...)에 둔다. 소스는 거기로 복사해서 빌드한다.

.PARAMETER KeepWork
  작업 폴더(build 중간 산출물, 약 80MB)를 지우지 않는다.
#>
[CmdletBinding()]
param(
    [string]$ToolchainDir,
    [string]$WorkDir,
    [string]$OutputApk,
    [string]$VersionName = '1.1.0',
    [int]$VersionCode = 2,
    [switch]$KeepWork,
    [switch]$Debuggable      # 진단용: WebView 를 PC 에서 원격 검사할 수 있는 빌드 (배포하지 말 것). 결과는 dist\SchmidtDatasheet-debug.apk
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProjectDir = $PSScriptRoot      # ※ Windows PowerShell 5.1 은 param() 기본값 안에서는 $PSScriptRoot 가 비어 있어 여기서 계산한다
$AppDir = Join-Path (Split-Path $ProjectDir -Parent) 'app'
if (-not $ToolchainDir) {
    $base = $env:LOCALAPPDATA
    if ($base -match '[^\u0000-\u007F]') { $base = $env:PUBLIC }      # 한글 사용자 이름 등 비ASCII 경로는 피한다
    $ToolchainDir = Join-Path $base 'schmidt-android\toolchain'
}
if (-not $WorkDir) { $WorkDir = Join-Path (Split-Path $ToolchainDir -Parent) 'work' }
if (-not $OutputApk) { $OutputApk = Join-Path $ProjectDir ('dist\SchmidtDatasheet.apk') }
if ($Debuggable -and $OutputApk -notmatch 'debug') { $OutputApk = Join-Path $ProjectDir 'dist\SchmidtDatasheet-debug.apk' }
$MinSdk = 24          # Android 7.0 이상
$TargetSdk = 34
$BuildToolsVersion = '34.0.0'

function Step([string]$Message) { Write-Host ''; Write-Host "== $Message" -ForegroundColor Cyan }

function Run([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "실패 (종료 코드 $LASTEXITCODE): $Exe $($Arguments -join ' ')" }
}

# 큰 파일을 내려받고 공식 체크섬으로 확인한다. 연결이 끊기면 이어받고(curl -C -), 체크섬이 틀리면 지우고 다시 받는다.
function Get-Verified([string]$Url, [string]$Dest, [string]$Algorithm, [string]$Expected) {
    New-Item -ItemType Directory -Force (Split-Path $Dest -Parent) | Out-Null
    $want = $Expected.ToUpperInvariant()
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        if (-not (Test-Path $Dest)) {
            Write-Host "  내려받는 중 ($attempt/4): $Url"
            $part = "$Dest.part"
            if ($curl) {
                & $curl.Source -L --fail --silent --show-error --retry 5 --retry-delay 3 --retry-all-errors -C - -o $part $Url
                if ($LASTEXITCODE -ne 0) { Write-Host "  (curl 종료 코드 $LASTEXITCODE — 이어서 다시 시도)"; continue }
            } else {
                Remove-Item $part -Force -ErrorAction SilentlyContinue
                try { Invoke-WebRequest -Uri $Url -OutFile $part -UseBasicParsing } catch { Write-Host "  ($($_.Exception.Message) — 다시 시도)"; continue }
            }
            Move-Item $part $Dest -Force
        }
        $actual = (Get-FileHash -Algorithm $Algorithm -Path $Dest).Hash
        if ($actual -eq $want) { Write-Host "  체크섬 확인 완료 ($Algorithm)"; return }
        Write-Host "  체크섬이 맞지 않아 파일을 지우고 다시 받습니다"
        Remove-Item $Dest -Force
    }
    throw "내려받기에 실패했습니다: $Url"
}

# zip 을 풀어 최상위 폴더 하나를 Dest 로 옮긴다 (jdk-17.x\..., android-14\... 같은 구조)
function Expand-Single([string]$Zip, [string]$Dest) {
    $tmp = "$Dest.extract"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    New-Item -ItemType Directory -Force $tmp | Out-Null
    Run 'tar.exe' @('-xf', $Zip, '-C', $tmp)
    New-Item -ItemType Directory -Force (Split-Path $Dest -Parent) | Out-Null
    $dirs = @(Get-ChildItem $tmp -Directory)
    $files = @(Get-ChildItem $tmp -File)
    if ($dirs.Count -eq 1 -and $files.Count -eq 0) {
        Move-Item $dirs[0].FullName $Dest
        Remove-Item $tmp -Recurse -Force
    } else {
        Move-Item $tmp $Dest
    }
}

function Ensure-Jdk {
    $jdk = Join-Path $ToolchainDir 'jdk17'
    if (Test-Path (Join-Path $jdk 'bin\javac.exe')) { return $jdk }
    Step 'JDK 17 (Eclipse Temurin) 준비'
    $meta = Invoke-RestMethod -Uri 'https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse'
    $pkg = $meta[0].binary.package
    $zip = Join-Path $ToolchainDir 'downloads\jdk17.zip'
    Get-Verified $pkg.link $zip 'SHA256' $pkg.checksum
    Expand-Single $zip $jdk
    return $jdk
}

function Get-SdkRepository {
    $xmlPath = Join-Path $ToolchainDir 'downloads\repository2-3.xml'
    New-Item -ItemType Directory -Force (Split-Path $xmlPath -Parent) | Out-Null
    if (-not (Test-Path $xmlPath)) {
        Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/repository2-3.xml' -OutFile $xmlPath -UseBasicParsing
    }
    $doc = New-Object System.Xml.XmlDocument
    $doc.Load($xmlPath)
    return $doc
}

function Ensure-SdkPackage([string]$Path, [string]$Dest) {
    if (Test-Path $Dest) { return }
    Step "Android SDK 구성요소 준비: $Path  (Android SDK 라이선스 적용: https://developer.android.com/studio/terms)"
    $doc = Get-SdkRepository
    $pkg = $doc.SelectSingleNode("//remotePackage[@path='$Path']")
    if ($null -eq $pkg) { throw "SDK 저장소에서 $Path 를 찾지 못했습니다" }
    $archive = $null
    foreach ($a in $pkg.SelectNodes('archives/archive')) {
        $os = $a.SelectSingleNode('host-os')
        if ($null -eq $os -or $os.InnerText -eq 'windows') { $archive = $a; break }
    }
    if ($null -eq $archive) { throw "$Path 의 Windows용 아카이브가 없습니다" }
    $complete = $archive.SelectSingleNode('complete')
    $name = $complete.SelectSingleNode('url').InnerText
    $sum = $complete.SelectSingleNode('checksum')
    $algo = 'SHA1'
    if ($sum.GetAttribute('type') -match '256') { $algo = 'SHA256' }
    $zip = Join-Path $ToolchainDir ("downloads\" + $name)
    Get-Verified ('https://dl.google.com/android/repository/' + $name) $zip $algo $sum.InnerText
    Expand-Single $zip $Dest
}

# ───────────────────────── 0) 도구 준비 ─────────────────────────
$jdk = Ensure-Jdk
$buildTools = Join-Path $ToolchainDir "sdk\build-tools\$BuildToolsVersion"
$platform = Join-Path $ToolchainDir "sdk\platforms\android-$TargetSdk"
Ensure-SdkPackage "build-tools;$BuildToolsVersion" $buildTools
Ensure-SdkPackage "platforms;android-$TargetSdk" $platform
Ensure-SdkPackage 'platform-tools' (Join-Path $ToolchainDir 'sdk\platform-tools')      # adb (USB 로 폰에 설치할 때 사용)

$androidJar = Join-Path $platform 'android.jar'
$aapt2 = Join-Path $buildTools 'aapt2.exe'
$d8 = Join-Path $buildTools 'd8.bat'
$zipalign = Join-Path $buildTools 'zipalign.exe'
$apksigner = Join-Path $buildTools 'apksigner.bat'
$javac = Join-Path $jdk 'bin\javac.exe'
$jar = Join-Path $jdk 'bin\jar.exe'
$keytool = Join-Path $jdk 'bin\keytool.exe'
foreach ($t in @($androidJar, $aapt2, $d8, $zipalign, $apksigner, $javac, $jar, $keytool)) {
    if (-not (Test-Path $t)) { throw "도구를 찾을 수 없습니다: $t" }
}
$env:JAVA_HOME = $jdk
$env:Path = "$jdk\bin;$env:Path"

# ───────────────────────── 1) 작업 폴더 구성 (ASCII 경로) ─────────────────────────
Step '작업 폴더 준비'
if (Test-Path $WorkDir) { Remove-Item $WorkDir -Recurse -Force }
New-Item -ItemType Directory -Force $WorkDir | Out-Null
Copy-Item (Join-Path $ProjectDir 'res') (Join-Path $WorkDir 'res') -Recurse
Copy-Item (Join-Path $ProjectDir 'src') (Join-Path $WorkDir 'src') -Recurse
Copy-Item (Join-Path $ProjectDir 'AndroidManifest.xml') $WorkDir
if ($Debuggable) {
    $mf = Join-Path $WorkDir 'AndroidManifest.xml'
    [System.IO.File]::WriteAllText($mf, [System.IO.File]::ReadAllText($mf).Replace('<application', '<application android:debuggable="true"'))
    Write-Host '  (디버그 빌드: android:debuggable=true)' -ForegroundColor Yellow
}

# 웹앱 → assets\www  (필요한 것만 골라 담는다: 서버, 테스트, QR 페이지, 문서 등은 제외)
$www = Join-Path $WorkDir 'assets\www'
New-Item -ItemType Directory -Force $www | Out-Null
foreach ($d in @('css', 'js', 'assets', 'models', 'icons')) { Copy-Item (Join-Path $AppDir $d) (Join-Path $www $d) -Recurse }
foreach ($f in @('index.html', 'NOTICE.md', 'manifest.webmanifest')) { Copy-Item (Join-Path $AppDir $f) $www }
New-Item -ItemType Directory -Force (Join-Path $www 'samples'), (Join-Path $www 'vendor\ort') | Out-Null
Copy-Item (Join-Path $AppDir 'samples\sample-record.jpg') (Join-Path $www 'samples')
foreach ($f in @('ort.wasm.bundle.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm')) {
    Copy-Item (Join-Path $AppDir "vendor\ort\$f") (Join-Path $www 'vendor\ort')
}
$wwwBytes = (Get-ChildItem $www -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("  웹 자산 {0:N1} MB" -f ($wwwBytes / 1MB))

# ───────────────────────── 2) 리소스 ─────────────────────────
Step '리소스 컴파일/링크 (aapt2)'
$resZip = Join-Path $WorkDir 'res.zip'
$baseApk = Join-Path $WorkDir 'base.apk'
Run $aapt2 @('compile', '--dir', (Join-Path $WorkDir 'res'), '-o', $resZip)
Run $aapt2 @('link', '-o', $baseApk, '-I', $androidJar,
    '--manifest', (Join-Path $WorkDir 'AndroidManifest.xml'),
    '--min-sdk-version', "$MinSdk", '--target-sdk-version', "$TargetSdk",
    '--version-code', "$VersionCode", '--version-name', $VersionName,
    $resZip)
# ※ 웹 자산은 aapt2 의 -A 로 넣지 않는다: Windows 의 aapt2 는 하위 폴더 경로를 'assets/www\js\main.js' 처럼
#   백슬래시로 저장해서 안드로이드가 파일을 찾지 못한다. 아래 4)에서 올바른 '/' 경로로 직접 추가한다.

# ───────────────────────── 3) Java → dex ─────────────────────────
Step 'Java 컴파일 (javac) → dex (d8)'
$classes = Join-Path $WorkDir 'classes'
New-Item -ItemType Directory -Force $classes | Out-Null
$sources = @(Get-ChildItem (Join-Path $WorkDir 'src') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName })
Run $javac (@('-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options', '-Xlint:deprecation',
    '-bootclasspath', $androidJar, '-d', $classes) + $sources)
$classesJar = Join-Path $WorkDir 'classes.jar'
Run $jar @('--create', '--file', $classesJar, '-C', $classes, '.')
$dexDir = Join-Path $WorkDir 'dex'
New-Item -ItemType Directory -Force $dexDir | Out-Null
Run $d8 @('--release', '--min-api', "$MinSdk", '--lib', $androidJar, '--output', $dexDir, $classesJar)

# ───────────────────────── 4) APK 합치기 / 정렬 ─────────────────────────
Step 'APK 조립 (dex + 웹 자산 추가 → zipalign)'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($baseApk, 'Update')
try {
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $dexDir 'classes.dex'), 'classes.dex', [System.IO.Compression.CompressionLevel]::Optimal)
    $assetsRoot = (Join-Path $WorkDir 'assets') + '\'
    foreach ($f in (Get-ChildItem $www -Recurse -File)) {
        $entryName = 'assets/' + $f.FullName.Substring($assetsRoot.Length).Replace('\', '/')      # 항상 '/' 구분자
        $level = [System.IO.Compression.CompressionLevel]::Optimal
        if ($f.Extension -match '^\.(png|jpe?g|onnx)$') { $level = [System.IO.Compression.CompressionLevel]::NoCompression }   # 이미 압축된/압축 안 되는 형식
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $entryName, $level)
    }
} finally { $zip.Dispose() }
$alignedApk = Join-Path $WorkDir 'aligned.apk'
Run $zipalign @('-f', '-p', '4', $baseApk, $alignedApk)

# ───────────────────────── 5) 서명 ─────────────────────────
Step '서명 (apksigner)'
$signingSrc = Join-Path $ProjectDir 'signing'
$signingWork = Join-Path $WorkDir 'signing'
New-Item -ItemType Directory -Force $signingWork | Out-Null
$ks = Join-Path $signingWork 'schmidt-datasheet.p12'
$propsFile = Join-Path $signingWork 'signing.properties'
if (Test-Path (Join-Path $signingSrc 'schmidt-datasheet.p12')) {
    Copy-Item (Join-Path $signingSrc '*') $signingWork -Force
} else {
    Write-Host '  서명 키가 없어 새로 만듭니다 (signing 폴더를 꼭 백업하세요: 이후 업데이트 설치에 같은 키가 필요합니다)'
    $bytes = New-Object byte[] 18
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $pw = [Convert]::ToBase64String($bytes).Replace('+', 'A').Replace('/', 'B')
    Run $keytool @('-genkeypair', '-keystore', $ks, '-storetype', 'PKCS12', '-storepass', $pw,
        '-alias', 'schmidt', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
        '-dname', 'CN=Schmidt Datasheet, O=Local, C=KR')
    [System.IO.File]::WriteAllText($propsFile, "storePassword=$pw`r`nalias=schmidt`r`n")
    New-Item -ItemType Directory -Force $signingSrc | Out-Null
    Copy-Item (Join-Path $signingWork '*') $signingSrc -Force
}
$props = @{}
foreach ($line in [System.IO.File]::ReadAllLines($propsFile)) {
    $i = $line.IndexOf('=')
    if ($i -gt 0) { $props[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim() }
}
$env:SCHMIDT_KS_PASS = $props['storePassword']       # 명령줄에 비밀번호가 노출되지 않도록 환경변수로 전달
$signedApk = Join-Path $WorkDir 'signed.apk'
Run $apksigner @('sign', '--ks', $ks, '--ks-pass', 'env:SCHMIDT_KS_PASS', '--ks-key-alias', $props['alias'],
    '--min-sdk-version', "$MinSdk",
    '--v1-signing-enabled', 'false', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true',    # API 24+ 는 v2 이상이면 충분
    '--out', $signedApk, $alignedApk)
Run $apksigner @('verify', '--verbose', '--print-certs', $signedApk)
Remove-Item Env:\SCHMIDT_KS_PASS -ErrorAction SilentlyContinue

# 결과물 점검: 한 번 잘못 만들어진 적이 있어(백슬래시 경로) 서명 뒤에 반드시 확인한다
$zip = [System.IO.Compression.ZipFile]::OpenRead($signedApk)
try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    $bad = @($names | Where-Object { $_.Contains('\') })
    if ($bad.Count -gt 0) { throw ("APK 항목 이름에 백슬래시가 있습니다: " + (($bad | Select-Object -First 3) -join ', ')) }
    $required = @('AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'assets/www/index.html', 'assets/www/js/main.js',
        'assets/www/js/ocr/engine.js', 'assets/www/js/library.js', 'assets/www/js/bundle.js', 'assets/www/js/store.js', 'assets/www/models/det.onnx', 'assets/www/models/rec.onnx', 'assets/www/models/dict.txt',
        'assets/www/vendor/ort/ort-wasm-simd-threaded.wasm', 'assets/www/vendor/ort/ort.wasm.bundle.min.mjs')
    $missing = @($required | Where-Object { $names -notcontains $_ })
    if ($missing.Count -gt 0) { throw ("APK 에 필수 파일이 없습니다: " + ($missing -join ', ')) }
    Write-Host ("  APK 점검 통과: 항목 {0}개, assets/www {1}개" -f $names.Count, @($names | Where-Object { $_ -like 'assets/www/*' }).Count)
} finally { $zip.Dispose() }

# ───────────────────────── 6) 결과 ─────────────────────────
Step '결과'
New-Item -ItemType Directory -Force (Split-Path $OutputApk -Parent) | Out-Null
Copy-Item $signedApk $OutputApk -Force
& $aapt2 dump badging $OutputApk | Select-String -Pattern "^package:|^sdkVersion|^targetSdkVersion|^uses-permission|^application-label:|^launchable-activity" | ForEach-Object { Write-Host ("  " + $_.Line) }
$size = (Get-Item $OutputApk).Length
Write-Host ("`n완료: {0}  ({1:N1} MB)" -f $OutputApk, ($size / 1MB)) -ForegroundColor Green
if (-not $KeepWork) { Remove-Item $WorkDir -Recurse -Force }
