package app.schmidt.datasheet;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * 슈미트해머 데이터시트 — 웹앱을 WebView 로 감싼 단독 실행 앱.
 *
 * 웹 화면과 OCR 엔진(WebAssembly + ONNX 모델)은 모두 APK 안(assets/www)에 들어 있고 PC·서버·인터넷이 필요 없다.
 * 문서함(저장한 문서와 기록지 사진)은 WebView 의 IndexedDB 에 저장되어 앱 안에만 남는다.
 * 네이티브로 연결한 것은 다음뿐이다:
 *   1) 사진/파일 선택: 카메라 촬영, 갤러리(여러 장 선택), ZIP 가져오기 (WebView 의 <input type=file> 은 앱이 직접 처리해 줘야 동작한다)
 *   2) 파일 내보내기: PDF·ZIP 을 [기기에 저장](문서 만들기 화면에서 위치 선택) 또는 [공유]. WebView 는 blob 다운로드를 처리하지 못해
 *      웹이 파일을 조각(base64)으로 넘기면 앱이 받아서 내보낸다. 저장소 권한이 필요 없다 (시스템 파일 선택 화면 사용)
 *   3) 인쇄: window.print() 는 WebView 에서 동작하지 않아 Android 인쇄 서비스로 연결
 *   4) 뒤로 가기: 열린 대화상자 닫기 → 화면 기록(작성 ↔ 문서함) → 두 번 눌러 종료
 */
public class MainActivity extends Activity {
    private static final String TAG = "SchmidtDatasheet";
    static final String VERSION = "1.1.0";
    private static final String START_URL = "https://" + AssetServer.HOST + "/index.html";
    private static final int REQ_FILE = 1001;
    private static final int REQ_SAVE = 1002;

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;   // 웹 페이지가 기다리는 파일 선택 결과
    private File cameraFile;                     // 이번 촬영이 써 넣을 임시 파일
    private long lastBackPress;

    private final Object saveLock = new Object();
    private SaveJob building;                    // 웹이 조각을 보내는 중인 파일
    private SaveJob saving;                      // 저장 위치를 고르는 중인 파일 (시스템 화면의 결과를 기다림)

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CaptureProvider.cleanOldCaptures(this);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);   // 디버그 빌드에서만 chrome://inspect 허용
        }
        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);
        configure(webView);
        webView.loadUrl(START_URL);
    }

    private void configure(WebView wv) {
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                       // localStorage (현장명·시험자 기억) + IndexedDB (문서함)
        s.setAllowFileAccess(false);                        // file:// 는 쓰지 않는다 (자산은 AssetServer 가 https 로 서비스)
        s.setAllowContentAccess(true);                      // 갤러리/카메라가 돌려주는 content:// 사진 읽기
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setTextZoom(100);
        s.setBuiltInZoomControls(false);
        // 웹 쪽이 앱으로 실행 중임을 알아채도록 UA 끝에 이름을 붙인다 (PC 전용 링크 숨김, 저장 브리지 사용 등)
        s.setUserAgentString(s.getUserAgentString() + " SchmidtDatasheetApp/" + VERSION);

        wv.setWebViewClient(new AppClient());
        wv.setWebChromeClient(new AppChrome());
        wv.addJavascriptInterface(new Bridge(), "AndroidBridge");
    }

    /* ───────── 페이지/자산 ───────── */

    private class AppClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return AssetServer.respond(getAssets(), request.getUrl());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (AssetServer.HOST.equalsIgnoreCase(u.getHost())) return false;   // 앱 안 이동
            try {                                                                  // 바깥 링크는 브라우저로
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException ignored) { }
            return true;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // 큰 사진을 처리하다 화면 처리 프로세스가 메모리 부족으로 죽은 경우: 앱이 같이 죽지 않게 다시 띄운다
            // (문서함은 IndexedDB 에 저장돼 있어 그대로 남는다)
            Log.w(TAG, "render process gone, crash=" + detail.didCrash());
            Toast.makeText(MainActivity.this, "메모리가 부족해 화면을 다시 불러옵니다.", Toast.LENGTH_LONG).show();
            recreate();
            return true;
        }
    }

    /* ───────── 사진/파일 선택: 카메라 / 갤러리 / ZIP ───────── */

    private class AppChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);   // 이전에 열려 있던 선택은 취소 처리
            fileCallback = callback;
            try {
                Intent intent;
                Intent camera = params.isCaptureEnabled() ? buildCameraIntent() : null;
                if (camera != null) {
                    intent = camera;                                       // "카메라로 촬영" 버튼 → 바로 카메라
                } else {
                    boolean images = onlyImages(params.getAcceptTypes());
                    Intent pick = new Intent(Intent.ACTION_GET_CONTENT);   // 그 밖에는 갤러리/파일 선택
                    pick.addCategory(Intent.CATEGORY_OPENABLE);
                    pick.setType(images ? "image/*" : "*/*");              // ZIP 가져오기는 파일 형식을 가리지 않고 고르게 한다 (ZIP 의 MIME 이 기기마다 달라서)
                    if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                        pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);  // 사진 여러 장 한꺼번에 추가
                    }
                    intent = Intent.createChooser(pick, images ? "결과기록지 사진 선택" : "가져올 파일 선택");
                }
                startActivityForResult(intent, REQ_FILE);
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, "사진을 가져올 앱을 찾지 못했습니다.", Toast.LENGTH_LONG).show();
                finishFileRequest(null);
            } catch (RuntimeException e) {
                Log.w(TAG, "file chooser failed", e);
                finishFileRequest(null);
            }
            return true;
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }
    }

    /** accept 가 이미지뿐이면 true (지정이 없으면 예전처럼 이미지) */
    private static boolean onlyImages(String[] types) {
        if (types == null) return true;
        for (String t : types) {
            if (t == null) continue;
            String s = t.trim().toLowerCase(Locale.ROOT);
            if (s.length() == 0) continue;
            if (!s.startsWith("image/")) return false;
        }
        return true;
    }

    /** 시스템 카메라 앱으로 찍고, 결과를 앱 캐시의 임시 파일에 받는다 (CAMERA 권한 불필요) */
    private Intent buildCameraIntent() {
        try {
            File f = CaptureProvider.newCaptureFile(this);
            cameraFile = f;
            Uri uri = CaptureProvider.uriFor(f);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, uri);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            i.setClipData(ClipData.newRawUri("capture", uri));      // 일부 기기에서 권한 부여가 ClipData 를 요구
            return i;
        } catch (IOException e) {
            Log.w(TAG, "cannot create capture file", e);
            cameraFile = null;
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_SAVE) {
            handleSaveResult(resultCode, data);
            return;
        }
        if (requestCode != REQ_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getData() != null) {
                result = new Uri[] { data.getData() };                          // 한 개 선택
            } else if (data != null && data.getClipData() != null && data.getClipData().getItemCount() > 0) {
                ClipData clip = data.getClipData();                             // 여러 개 선택: 선택한 순서대로 모두 돌려준다
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = clip.getItemAt(i).getUri();
            } else if (cameraFile != null && cameraFile.exists() && cameraFile.length() > 0) {
                result = new Uri[] { CaptureProvider.uriFor(cameraFile) };      // 카메라 촬영
            }
        }
        finishFileRequest(result);
    }

    /** 웹 페이지에 결과를 돌려준다 (null 이면 취소) */
    private void finishFileRequest(Uri[] result) {
        ValueCallback<Uri[]> cb = fileCallback;
        fileCallback = null;
        if (cb != null) cb.onReceiveValue(result);
    }

    /* ───────── 파일 내보내기: 저장 / 공유 ───────── */

    /** 웹이 조각 단위로 보내 주는 파일 하나 */
    private static final class SaveJob {
        final String id, name, mime, mode;
        final File file;
        OutputStream out;

        SaveJob(String id, String name, String mime, String mode, File file) {
            this.id = id; this.name = name; this.mime = mime; this.mode = mode; this.file = file;
        }

        void closeQuietly() {
            try { if (out != null) out.close(); } catch (IOException ignored) { }
            out = null;
        }
    }

    private void discardLocked(SaveJob j) {
        if (j == null) return;
        j.closeQuietly();
        CaptureProvider.deleteExport(j.file);
    }

    /** 웹의 [PDF 저장] / [ZIP으로 내보내기]가 호출한다. 흐름: saveBegin → saveChunk(여러 번) → saveFinish → (결과는 JS 의 window.__onNativeSave) */
    private class Bridge {
        @JavascriptInterface
        public void print(final String title) {
            runOnUiThread(new Runnable() {
                @Override public void run() { printPage(title); }
            });
        }

        @JavascriptInterface
        public String version() { return VERSION; }

        @JavascriptInterface
        public boolean saveBegin(String id, String name, String mime, String mode) {
            synchronized (saveLock) {
                discardLocked(building);
                building = null;
                try {
                    File f = CaptureProvider.newExportFile(MainActivity.this, name);
                    SaveJob j = new SaveJob(id, f.getName(),
                            (mime == null || mime.length() == 0) ? "application/octet-stream" : mime,
                            "share".equals(mode) ? "share" : "save", f);
                    j.out = new BufferedOutputStream(new FileOutputStream(f), 64 * 1024);
                    building = j;
                    return true;
                } catch (IOException e) {
                    Log.w(TAG, "saveBegin failed", e);
                    return false;
                }
            }
        }

        @JavascriptInterface
        public boolean saveChunk(String id, String base64) {
            synchronized (saveLock) {
                SaveJob j = building;
                if (j == null || !j.id.equals(id) || j.out == null) return false;
                try {
                    j.out.write(Base64.decode(base64, Base64.DEFAULT));
                    return true;
                } catch (IOException e) {                    // 저장 공간 부족 등
                    Log.w(TAG, "saveChunk failed", e);
                    discardLocked(j);
                    building = null;
                    return false;
                } catch (IllegalArgumentException e) {
                    Log.w(TAG, "saveChunk bad base64", e);
                    discardLocked(j);
                    building = null;
                    return false;
                }
            }
        }

        @JavascriptInterface
        public void saveFinish(final String id) {
            final SaveJob j;
            synchronized (saveLock) {
                j = building;
                if (j == null || !j.id.equals(id)) {
                    notifySave(id, "error", "파일 전송 상태가 올바르지 않습니다");
                    return;
                }
                building = null;
                j.closeQuietly();
            }
            runOnUiThread(new Runnable() {
                @Override public void run() { launchSave(j); }
            });
        }

        @JavascriptInterface
        public void saveAbort(String id) {
            synchronized (saveLock) {
                if (building != null && building.id.equals(id)) {
                    discardLocked(building);
                    building = null;
                }
            }
        }
    }

    /** 다 받은 파일을 시스템의 [저장 위치 선택] 또는 [공유] 화면으로 넘긴다 (UI 스레드) */
    private void launchSave(SaveJob j) {
        try {
            if ("share".equals(j.mode)) {
                Uri uri = CaptureProvider.exportUri(j.file);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(j.mime);
                send.putExtra(Intent.EXTRA_STREAM, uri);
                send.putExtra(Intent.EXTRA_SUBJECT, j.name);
                send.setClipData(ClipData.newRawUri(j.name, uri));
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(send, "내보내기"));
                notifySave(j.id, "ok", "");                      // 공유는 결과를 돌려받을 수 없다. 임시 파일은 하루 뒤 정리된다
            } else {
                Intent create = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                create.addCategory(Intent.CATEGORY_OPENABLE);
                create.setType(j.mime);
                create.putExtra(Intent.EXTRA_TITLE, j.name);
                saving = j;
                startActivityForResult(create, REQ_SAVE);
            }
        } catch (ActivityNotFoundException e) {
            saving = null;
            CaptureProvider.deleteExport(j.file);
            notifySave(j.id, "error", "파일을 저장하거나 공유할 앱을 찾지 못했습니다");
        } catch (RuntimeException e) {
            Log.w(TAG, "launchSave failed", e);
            saving = null;
            CaptureProvider.deleteExport(j.file);
            notifySave(j.id, "error", String.valueOf(e.getMessage()));
        }
    }

    /** 사용자가 고른 위치에 임시 파일을 복사한다 */
    private void handleSaveResult(int resultCode, Intent data) {
        final SaveJob j = saving;
        saving = null;
        if (j == null) return;
        if (resultCode != RESULT_OK || data == null || data.getData() == null) {
            CaptureProvider.deleteExport(j.file);
            notifySave(j.id, "cancelled", "");
            return;
        }
        final Uri dest = data.getData();
        new Thread(new Runnable() {
            @Override public void run() {
                String status = "ok";
                String message = j.name;
                try {
                    copyTo(j.file, dest);
                    message = displayName(dest, j.name);
                } catch (IOException e) {
                    Log.w(TAG, "save copy failed", e);
                    status = "error";
                    message = "선택한 위치에 파일을 쓰지 못했습니다";
                } finally {
                    CaptureProvider.deleteExport(j.file);
                }
                notifySave(j.id, status, message);
            }
        }, "save-copy").start();
    }

    private void copyTo(File src, Uri dest) throws IOException {
        InputStream in = new FileInputStream(src);
        try {
            OutputStream out = getContentResolver().openOutputStream(dest, "wt");
            if (out == null) throw new IOException("cannot open " + dest);
            try {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                out.flush();
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
    }

    private String displayName(Uri uri, String fallback) {
        Cursor c = null;
        try {
            c = getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && n.length() > 0) return n;
            }
        } catch (RuntimeException ignored) {
        } finally {
            if (c != null) c.close();
        }
        return fallback;
    }

    /** 웹에 결과를 알린다: window.__onNativeSave(id, 'ok' | 'cancelled' | 'error', 메시지) */
    private void notifySave(final String id, final String status, final String message) {
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (webView == null) return;
                webView.evaluateJavascript("window.__onNativeSave&&window.__onNativeSave("
                        + JSONObject.quote(id) + "," + JSONObject.quote(status) + "," + JSONObject.quote(message) + ")", null);
            }
        });
    }

    /* ───────── 인쇄 ───────── */

    private void printPage(String title) {
        if (webView == null) return;
        try {
            String job = (title == null || title.trim().length() == 0) ? "슈미트해머_데이터시트" : title.trim();
            PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
            PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(job);
            PrintAttributes attrs = new PrintAttributes.Builder()
                    .setMediaSize(PrintAttributes.MediaSize.ISO_A4.asLandscape())              // 양식은 A4 가로
                    .setMinMargins(new PrintAttributes.Margins(315, 315, 315, 315))             // 8mm (1/1000 인치)
                    .build();
            pm.print(job, adapter, attrs);
        } catch (RuntimeException e) {
            Log.w(TAG, "print failed", e);
            Toast.makeText(this, "인쇄 화면을 열 수 없습니다.", Toast.LENGTH_LONG).show();
        }
    }

    /* ───────── 뒤로 가기 / 생명주기 ───────── */

    /**
     * 뒤로 가기 순서: ① 웹이 먼저 처리(열린 대화상자 닫기, 문서함 선택 해제)
     *                ② 화면 기록 뒤로(문서함 → 작성)  ③ 두 번 눌러 종료
     */
    @Override
    public void onBackPressed() {
        final WebView wv = webView;
        if (wv == null) { super.onBackPressed(); return; }
        final boolean[] answered = { false };
        final Runnable fallback = new Runnable() {
            @Override public void run() {
                if (answered[0]) return;
                answered[0] = true;
                defaultBack();
            }
        };
        wv.postDelayed(fallback, 800);                           // 웹이 응답하지 못하는 상태여도 뒤로 가기가 먹통이 되지 않게
        wv.evaluateJavascript("(function(){try{return !!(window.__onBack&&window.__onBack());}catch(e){return false;}})()",
                new ValueCallback<String>() {
                    @Override public void onReceiveValue(String value) {
                        if (answered[0]) return;
                        answered[0] = true;
                        wv.removeCallbacks(fallback);
                        if ("true".equals(value)) return;       // 웹이 처리했다
                        defaultBack();
                    }
                });
    }

    private void defaultBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBackPress < 2000) {
            finish();
            return;
        }
        lastBackPress = now;
        Toast.makeText(this, "한 번 더 누르면 종료됩니다", Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        if (webView != null) webView.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        finishFileRequest(null);
        synchronized (saveLock) {
            discardLocked(building);
            building = null;
        }
        if (webView != null) {
            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent != null) parent.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
