# 안드로이드 앱 (APK) — PC 없이 폰 단독 실행

`app/` 의 웹앱을 `WebView` 로 감싼 앱입니다. 화면, OCR 엔진(WebAssembly), 모델이 모두 APK 안에 들어 있어서
**설치하고 나면 PC도 Wi-Fi도 인터넷도 필요 없습니다.**

- 앱 이름 `슈미트해머`, 패키지 `app.schmidt.datasheet`, Android 7.0(API 24) 이상
- **권한을 하나도 요청하지 않습니다.** `INTERNET` 이 없어서 앱이 네트워크를 쓸 수 없고(사진이 밖으로 나갈 수 없음),
  카메라는 폰의 기본 카메라 앱으로 찍어 결과만 받으므로 `CAMERA` 권한도 필요 없습니다.
- 필요 조건: WebView 91 이상 (WebAssembly SIMD). 대부분 기기는 Play 스토어가 WebView를 자동 업데이트합니다.

## 폰에 설치하기 — USB 로 PC 에서 바로 설치

QR·링크로 내려받지 않고, **폰을 USB 로 PC 에 연결해 `adb` 로 직접 설치**합니다.

1. **폰 준비 (처음 한 번)**
   - 설정 > 휴대전화 정보 > 소프트웨어 정보 > **빌드번호를 7번** 눌러 개발자 옵션 켜기
   - 설정 > 개발자 옵션 > **USB 디버깅** 켜기
   - 삼성 폰은 설정 > 보안 및 개인정보 보호 > **자동 차단(Auto Blocker)** 이 켜져 있으면 USB 설치가 막히니 끄기
2. USB 케이블로 PC 에 연결 → 폰에 **"USB 디버깅을 허용하시겠습니까?"** 가 뜨면 **허용** (이 컴퓨터에서 항상 허용 체크).
   충전만 되면 알림창에서 USB 사용 방식을 "파일 전송"으로 바꿉니다.
3. PC 에서 `install-usb.bat` 실행 → 폰을 찾아 `adb install -r` 로 설치(기존 앱 위에 덮어쓰기, **저장된 문서 유지**)하고 앱을 실행합니다.
   폰이 안 보이거나 허용 대기 중이면 무엇을 해야 하는지 화면에 안내합니다.
4. 홈 화면의 **슈미트해머** 아이콘으로 실행. 결과기록지는 `카메라로 촬영` 으로 바로 찍으면 됩니다.

`adb`(Android platform-tools)는 `build-apk.bat` 이 도구를 내려받을 때 함께 받습니다.
## 앱이 하는 일

| 구분 | 내용 |
| --- | --- |
| 화면/OCR | `assets/www` 의 웹앱을 가상 주소 `https://appassets.androidplatform.net/` 로 서비스 (`AssetServer.java`). 정상 https 출처처럼 보여서 서버에서 열 때와 똑같이 동작(보안 컨텍스트, ES 모듈, WASM, 웹 워커) |
| 사진 선택 | 웹의 `카메라로 촬영` → 폰 카메라 앱, `사진 선택` → 갤러리/파일 (`MainActivity.java`, 촬영 임시 파일은 `CaptureProvider.java` 가 앱 캐시에 만들고 하루 뒤 지움) |
| 문서함 | 저장한 문서와 기록지 사진은 WebView 의 IndexedDB 에 저장 (앱 안에만 남고 앱을 지우면 사라짐). 사진 여러 장 선택(EXTRA_ALLOW_MULTIPLE)과 ZIP 가져오기 파일 선택을 지원 |
| PDF·ZIP 내보내기 | 웹의 PDF 저장 / ZIP으로 내보내기 → 웹이 파일을 조각(base64)으로 넘기면 앱이 받아 **기기에 저장**(시스템 파일 저장 화면, 저장소 권한 불필요) 또는 **공유**(카카오톡·메일 등). MainActivity.java 의 saveBegin/saveChunk/saveFinish, 공유용 임시 파일은 CaptureProvider.java 의 exports/ |
| 인쇄 | 웹의 인쇄 → Android 인쇄 화면(A4 가로) → 프린터 또는 PDF로 저장 |
| 입력 기억 | 현장명·시험자 등은 앱 저장소에 기억 (앱 데이터를 지우면 사라짐) |
| 뒤로 가기 | 열린 대화상자 닫기 → 문서함 선택 해제 → 화면 이동(문서함 → 작성) → 두 번 눌러 종료 |

## 다시 빌드하기

웹앱(`..\app`)을 고친 뒤 `build-apk.bat` 을 실행하면 `dist\SchmidtDatasheet.apk` 가 새로 만들어집니다.

```
build-apk.bat                              버전은 그대로
powershell -File build.ps1 -VersionCode 3 -VersionName 1.1.1     업데이트 배포용 (versionCode 를 올려야 덮어 설치됨)
```

- **첫 빌드 때 도구를 내려받습니다 (약 600MB, 체크섬 확인).** JDK 17(Eclipse Temurin, GPLv2+Classpath Exception)과
  Android build-tools 34 / platform 34(Google, [Android SDK 라이선스](https://developer.android.com/studio/terms) 적용).
  Gradle/Android Studio 는 필요 없습니다 (`aapt2` + `javac` + `d8` + `apksigner` 직접 호출).
- 한글 사용자 이름 경로에서는 안드로이드 도구가 실패할 수 있어 도구와 작업 폴더를 `C:\Users\Public\schmidt-android\` (ASCII 경로)에 둡니다.
  지워도 되며 다음 빌드 때 다시 받습니다.
- 빌드 결과를 직접 확인하려면 `-KeepWork` (중간 산출물 유지).

## 서명 키 — 꼭 백업하세요

처음 빌드할 때 `signing\schmidt-datasheet.p12` 와 비밀번호 파일 `signing\signing.properties` 가 만들어집니다.
**이 폴더를 잃어버리면** 이후 버전을 기존 앱 위에 업데이트할 수 없습니다(앱을 지우고 다시 설치해야 하고 앱 안의 저장값이 사라짐).
외부에 공유하지 마세요.

## 검증 상태 (솔직한 기록)

- ✅ **APK 구조**: `aapt2 dump badging` (패키지 `app.schmidt.datasheet`, minSdk 24 / targetSdk 34, **권한 0개**),
  `apksigner verify` (v2·v3 서명), `zipalign -c`, `resources.arsc` 비압축(Android 11+ 요건), dex 에 `MainActivity`·`AssetServer`·`CaptureProvider` 포함
- ✅ **APK 안의 웹 자산 21개가 현재 `app/` 소스와 SHA-256까지 동일**
- ✅ **웹 부분**: APK 에서 꺼낸 `assets/www` 를 앱과 같은 규칙(가상 https 출처 `appassets.androidplatform.net`, 같은 MIME·격리 헤더, 앱 UA, 인쇄 브리지)으로
  브라우저에서 서비스해 시험 — OCR 20/20, 인쇄 브리지 호출, 자산 404 없음, 외부 호스트·경로 탈출 차단,
  그리고 웹 워커를 못 쓰는 환경을 흉내 낸 **메인 스레드 폴백**(단일 스레드)도 동일하게 20/20
- ✅ **실제 기기(Galaxy SM-S948N, Android 17)에서 실행 확인** — 아래 "기기에서 확인한 것" 참고. 단, **카메라 앱으로 직접 촬영하는 흐름과 Android 인쇄 화면은 이 기기에서 시험하지 못했습니다.**
  기기·WebView 버전에 따라 다를 수 있는 부분: ① 교차 출처 격리(멀티스레드) 지원 여부(안 되면 자동으로 단일 스레드) ② 카메라 앱이 촬영 결과를 앱의 임시 파일에 쓰는 방식 ③ 인쇄 화면의 용지 설정.
  이상이 있으면 알려 주세요. 화면 로그는 `adb logcat -s SchmidtDatasheet` 로 볼 수 있습니다.

## 기기에서 확인한 것 (Galaxy SM-S948N, Android 17, WebView 156)

USB 로 직접 설치해서 실제 기기에서 확인했습니다: 앱 실행·화면, **OCR(샘플 20/20, 1.4초)**, 문서함 저장·목록, **PDF/ZIP 만들기**(한글 파일명, 양식 2쪽 PDF 포함),
**기기에 저장**(시스템 저장 화면 → 다운로드 폴더) 후 PC 로 가져와 ZIP 내용 검증, **다른 앱으로 공유** 시트, 뒤로 가기 단계, **사진 여러 장 선택 → 일괄 저장**(회전된 사진 포함), 삭제.
카메라 앱으로 직접 촬영하는 흐름과 Android 인쇄 화면(`인쇄` 버튼)은 이 기기에서 시험하지 못했습니다.

- **`canvas.toBlob()` 은 WebView 에서 호출마다 정확히 4초가 걸립니다** (한가해질 때까지 기다리다 4초 뒤 인코딩). 그래서 PDF 한 장에 13초씩 걸렸고, `toDataURL` 로 바꿔 0.3초가 됐습니다. 이미지를 JPEG 로 뽑을 때는 `sheetimage.js` 의 `canvasToBlob` 을 쓰세요.
- 문제가 생기면 `adb logcat -s SchmidtDatasheet` (웹 콘솔 로그가 나옵니다. 예: `[pdf] …ms`).
- WebView 를 PC 에서 검사하려면 진단용 빌드: `powershell -File build.ps1 -Debuggable` → `dist\SchmidtDatasheet-debug.apk` 설치 →
  `adb forward tcp:9222 localabstract:webview_devtools_remote_<앱 PID>` 후 `http://127.0.0.1:9222/json`. **배포용이 아니므로 확인이 끝나면 일반 빌드로 다시 설치하세요.**
## 개발 메모

- 웹 자산은 `aapt2 link -A` 가 아니라 `build.ps1` 이 직접 APK 에 넣습니다. Windows 의 aapt2 는 하위 폴더 경로를 `assets/www\js\main.js` 처럼
  **백슬래시로 저장해서 안드로이드가 파일을 못 찾는** 문제가 있기 때문입니다. 빌드 마지막에 백슬래시 이름·필수 파일 누락을 검사하고, 문제가 있으면 빌드를 실패시킵니다.
- WebView 에서 웹 워커가 막히는 환경을 대비해, 웹 쪽이 시작할 때 워커 사용 가능 여부를 확인하고 안 되면 메인 스레드로 추론합니다 (`app/js/ocr/loader.js`).
  주소에 `?workers=0` 을 붙이면 그 경로를 강제로 시험할 수 있습니다.
