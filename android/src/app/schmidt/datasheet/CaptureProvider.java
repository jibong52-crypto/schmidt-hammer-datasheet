package app.schmidt.datasheet;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.List;
import java.util.Locale;

/**
 * 앱 캐시 폴더의 파일을 content:// 주소로 내주는 최소한의 ContentProvider (androidx FileProvider 와 같은 역할, 외부 라이브러리 없음).
 * 외부로 노출되지 않으며(exported=false), 그때그때 intent 로 해당 파일 하나에 대한 권한만 임시로 부여한다.
 *
 *   captures/<파일>               카메라 앱이 촬영한 사진을 써 넣는 임시 파일 (읽기/쓰기)
 *   exports/<고유폴더>/<파일>     문서함에서 내보낸 PDF/ZIP 을 다른 앱으로 공유할 때의 임시 파일 (읽기 전용)
 *                                 받는 앱이 파일 이름(DISPLAY_NAME)을 그대로 쓰도록 이름을 보존하려고 폴더를 하나 더 둔다
 */
public class CaptureProvider extends ContentProvider {
    static final String AUTHORITY = "app.schmidt.datasheet.captures";
    private static final long KEEP_MS = 24L * 60 * 60 * 1000;

    static File dir(Context c) {
        File d = new File(c.getCacheDir(), "captures");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static File exportsDir(Context c) {
        File d = new File(c.getCacheDir(), "exports");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    static File newCaptureFile(Context c) throws IOException {
        return File.createTempFile("capture_", ".jpg", dir(c));
    }

    static Uri uriFor(File f) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(f.getName()).build();
    }

    /** 파일 이름으로 쓸 수 없는 글자를 바꾸고 길이를 줄인다 (확장자는 남긴다) */
    static String safeName(String name) {
        String n = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (n.length() == 0 || n.equals(".") || n.equals("..")) n = "export";
        if (n.length() > 120) {
            int dot = n.lastIndexOf('.');
            String ext = (dot > 0 && n.length() - dot <= 8) ? n.substring(dot) : "";
            n = n.substring(0, 120 - ext.length()) + ext;
        }
        return n;
    }

    /** exports/<고유폴더>/<이름> 에 새 내보내기 파일을 만든다 (아직 내용은 비어 있음) */
    static File newExportFile(Context c, String name) throws IOException {
        File d = new File(exportsDir(c), Long.toHexString(System.nanoTime()) + Integer.toHexString((int) (Math.random() * 0xffff)));
        if (!d.mkdirs()) throw new IOException("cannot create export dir");
        return new File(d, safeName(name));
    }

    static Uri exportUri(File f) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY)
                .appendPath("exports").appendPath(f.getParentFile().getName()).appendPath(f.getName()).build();
    }

    static void deleteExport(File f) {
        if (f == null) return;
        File d = f.getParentFile();
        f.delete();
        if (d != null) d.delete();
    }

    /** 하루가 지난 촬영/내보내기 임시 파일을 지운다 (사진과 문서가 기기에 쌓이지 않도록) */
    static void cleanOldCaptures(Context c) {
        long limit = System.currentTimeMillis() - KEEP_MS;
        File[] files = dir(c).listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.lastModified() < limit) f.delete();
            }
        }
        File[] dirs = exportsDir(c).listFiles();
        if (dirs != null) {
            for (File d : dirs) {
                if (d.lastModified() >= limit) continue;
                File[] inner = d.listFiles();
                if (inner != null) for (File f : inner) f.delete();
                d.delete();
            }
        }
    }

    private boolean isExport(Uri uri) {
        List<String> seg = uri.getPathSegments();
        return seg.size() == 3 && "exports".equals(seg.get(0));
    }

    private File resolve(Uri uri) throws FileNotFoundException {
        List<String> seg = uri.getPathSegments();
        for (String s : seg) {
            if (s.length() == 0 || s.indexOf('/') >= 0 || s.indexOf('\\') >= 0 || s.contains("..")) {
                throw new FileNotFoundException("bad name");
            }
        }
        Context c = getContext();
        if (seg.size() == 1) return new File(dir(c), seg.get(0));
        if (isExport(uri)) return new File(new File(exportsDir(c), seg.get(1)), seg.get(2));
        throw new FileNotFoundException("bad path");
    }

    @Override public boolean onCreate() { return true; }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (isExport(uri) && !"r".equals(mode)) throw new FileNotFoundException("read only");
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.parseMode(mode));
    }

    @Override
    public String getType(Uri uri) {
        if (!isExport(uri)) return "image/jpeg";
        String n = String.valueOf(uri.getLastPathSegment()).toLowerCase(Locale.ROOT);
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".pdf")) return "application/pdf";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".csv")) return "text/csv";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        try {
            File f = resolve(uri);
            String[] cols = projection != null ? projection : new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
            Object[] row = new Object[cols.length];
            for (int i = 0; i < cols.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
                else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
            }
            MatrixCursor cursor = new MatrixCursor(cols, 1);
            cursor.addRow(row);
            return cursor;
        } catch (FileNotFoundException e) {
            return null;
        }
    }

    @Override public Uri insert(Uri uri, ContentValues values) { return null; }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        try { return resolve(uri).delete() ? 1 : 0; } catch (FileNotFoundException e) { return 0; }
    }

    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { return 0; }
}
