package app.schmidt.datasheet;

import android.content.res.AssetManager;
import android.net.Uri;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * APK 안의 웹 자산(assets/www)을 가상 https 주소(https://appassets.androidplatform.net/…)로 서비스한다.
 *
 * file:// 로 직접 열지 않는 이유: file:// 에서는 ES 모듈, WebAssembly, 웹 워커, fetch 가 막히거나 동작이 달라진다.
 * 정상적인 https 출처처럼 보이게 하면 서버에서 열었을 때와 같은 방식으로 동작한다 (보안 컨텍스트).
 *
 * 응답에 교차 출처 격리 헤더(COOP/COEP)를 붙여, WebView 가 지원하면 OCR 엔진이 멀티스레드로 돈다.
 * 지원하지 않으면 웹 쪽이 알아서 단일 스레드로 동작한다.
 */
final class AssetServer {
    static final String HOST = "appassets.androidplatform.net";
    private static final String ROOT = "www/";
    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final Map<String, String> MIME = new HashMap<String, String>();

    static {
        MIME.put("html", "text/html");
        MIME.put("js", "text/javascript");
        MIME.put("mjs", "text/javascript");
        MIME.put("css", "text/css");
        MIME.put("json", "application/json");
        MIME.put("txt", "text/plain");
        MIME.put("md", "text/plain");
        MIME.put("wasm", "application/wasm");      // WebAssembly 스트리밍 컴파일에 필요
        MIME.put("onnx", "application/octet-stream");
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("svg", "image/svg+xml");
        MIME.put("ico", "image/x-icon");
    }

    private AssetServer() { }

    static WebResourceResponse respond(AssetManager assets, Uri uri) {
        // 이 앱은 자기 출처의 자산만 연다. 그 밖의 요청은 네트워크로 나가지 않도록 막는다.
        if (!"https".equals(uri.getScheme()) || !HOST.equalsIgnoreCase(uri.getHost())) {
            return error(403, "Forbidden");
        }
        String path = uri.getPath();
        if (path == null || path.length() == 0 || "/".equals(path)) path = "/index.html";
        path = path.substring(1);
        if (path.contains("..") || path.indexOf('\\') >= 0 || path.startsWith("/")) {
            return error(403, "Forbidden");
        }
        try {
            InputStream in = assets.open(ROOT + path, AssetManager.ACCESS_STREAMING);
            String mime = mimeOf(path);
            boolean text = mime.startsWith("text/") || "application/json".equals(mime);
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers(), in);
        } catch (IOException e) {
            return error(404, "Not Found");
        }
    }

    private static String mimeOf(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String mime = MIME.get(ext);
        return mime != null ? mime : "application/octet-stream";
    }

    private static Map<String, String> headers() {
        Map<String, String> h = new HashMap<String, String>();
        h.put("Cross-Origin-Opener-Policy", "same-origin");
        h.put("Cross-Origin-Embedder-Policy", "require-corp");
        h.put("Cross-Origin-Resource-Policy", "same-origin");
        h.put("Cache-Control", "no-cache");
        return h;
    }

    private static WebResourceResponse error(int status, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, headers(),
                new ByteArrayInputStream(reason.getBytes(UTF8)));
    }
}
