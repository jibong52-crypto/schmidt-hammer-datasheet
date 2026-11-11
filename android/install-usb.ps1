<#
.SYNOPSIS
  빌드한 APK 를 USB 로 연결된 안드로이드 폰에 설치하고 실행한다 (adb).

.DESCRIPTION
  폰 준비 (처음 한 번):
    1) 설정 > 휴대전화 정보 > 소프트웨어 정보 > "빌드번호"를 7번 눌러 개발자 옵션을 켠다
    2) 설정 > 개발자 옵션 > "USB 디버깅" 켜기
    3) USB 케이블로 PC 에 연결 → 폰 화면에 "USB 디버깅을 허용하시겠습니까?"가 뜨면 [허용] (이 컴퓨터에서 항상 허용 체크)
  폰이 "충전만"으로 연결되면 알림창에서 USB 사용 방식을 "파일 전송"으로 바꾼다.
  삼성 폰: 설정 > 보안 및 개인정보 보호 > 자동 차단(Auto Blocker)이 켜져 있으면 USB 설치가 막히니 끈다.
#>
[CmdletBinding()]
param(
    [string]$Apk,
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$ProjectDir = $PSScriptRoot
if (-not $Apk) { $Apk = Join-Path $ProjectDir 'dist\SchmidtDatasheet.apk' }
$base = $env:LOCALAPPDATA
if ($base -match '[^\u0000-\u007F]') { $base = $env:PUBLIC }
$adb = Join-Path $base 'schmidt-android\toolchain\sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb 가 없습니다. 먼저 build-apk.bat 을 실행하세요 (빌드 때 platform-tools 를 내려받습니다): $adb" }
if (-not (Test-Path $Apk)) { throw "APK 가 없습니다. 먼저 build-apk.bat 을 실행하세요: $Apk" }
$Package = 'app.schmidt.datasheet'

function Get-Devices {
    $lines = & $adb devices 2>&1 | Select-Object -Skip 1 | Where-Object { $_ -match '\S' }
    foreach ($l in $lines) {
        $parts = ($l -split '\s+')
        if ($parts.Count -ge 2) { [pscustomobject]@{ Serial = $parts[0]; State = $parts[1] } }
    }
}

& $adb start-server | Out-Null
$devices = @(Get-Devices)
if ($devices.Count -eq 0) {
    Write-Host '연결된 폰이 없습니다.' -ForegroundColor Yellow
    Write-Host '  · USB 케이블로 폰을 PC 에 연결하고, 폰에서 개발자 옵션 > USB 디버깅을 켜세요.'
    Write-Host '  · 폰 화면에 "USB 디버깅을 허용하시겠습니까?"가 뜨면 [허용]을 누르세요.'
    Write-Host '  · 충전 전용 케이블이면 인식되지 않습니다. 알림창에서 USB 모드를 "파일 전송"으로 바꿔 보세요.'
    exit 2
}
$bad = @($devices | Where-Object { $_.State -ne 'device' })
foreach ($d in $bad) {
    switch ($d.State) {
        'unauthorized' { Write-Host "[$($d.Serial)] 폰에서 'USB 디버깅 허용' 창을 확인하고 [허용]을 누르세요 (이 컴퓨터에서 항상 허용 체크)." -ForegroundColor Yellow }
        'offline'      { Write-Host "[$($d.Serial)] 오프라인 상태입니다. 케이블을 다시 꽂고 USB 디버깅을 껐다 켜 보세요." -ForegroundColor Yellow }
        default        { Write-Host "[$($d.Serial)] 상태: $($d.State)" -ForegroundColor Yellow }
    }
}
$ready = @($devices | Where-Object { $_.State -eq 'device' })
if ($ready.Count -eq 0) { exit 3 }
if ($ready.Count -gt 1) { Write-Host "폰이 $($ready.Count)대 연결되어 있습니다. 하나만 연결하고 다시 실행하세요." -ForegroundColor Yellow; exit 4 }
$serial = $ready[0].Serial
$model = (& $adb -s $serial shell getprop ro.product.model).Trim()
$android = (& $adb -s $serial shell getprop ro.build.version.release).Trim()
Write-Host "연결된 폰: $model (Android $android, $serial)" -ForegroundColor Cyan

Write-Host ("설치 중: {0} ({1:N1} MB)" -f $Apk, ((Get-Item $Apk).Length / 1MB))
$out = & $adb -s $serial install -r $Apk 2>&1 | Out-String
Write-Host $out.Trim()
if ($out -notmatch 'Success') {
    if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match') {
        Write-Host '이미 설치된 앱의 서명이 달라 업데이트할 수 없습니다. 폰에서 기존 앱을 삭제한 뒤 다시 실행하세요 (저장된 문서도 함께 지워집니다).' -ForegroundColor Yellow
    } elseif ($out -match 'USER_RESTRICTED|INSTALL_FAILED_USER_RESTRICTED|Install canceled') {
        Write-Host '폰이 USB 설치를 막고 있습니다. 개발자 옵션의 "USB를 통해 설치"를 켜고, 삼성 폰은 보안 > 자동 차단을 끄세요. 폰에 설치 확인 창이 뜨면 허용하세요.' -ForegroundColor Yellow
    }
    exit 5
}
if (-not $NoLaunch) {
    & $adb -s $serial shell am start -n "$Package/.MainActivity" | Out-Null
    Write-Host '앱을 실행했습니다.' -ForegroundColor Green
}
$info = & $adb -s $serial shell dumpsys package $Package 2>&1 | Select-String -Pattern 'versionName|versionCode' | ForEach-Object { $_.Line.Trim() } | Select-Object -First 2
Write-Host ('설치된 버전: ' + ($info -join ' '))
Write-Host '완료.' -ForegroundColor Green