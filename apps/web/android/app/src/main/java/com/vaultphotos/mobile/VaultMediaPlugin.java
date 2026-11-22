package com.vaultphotos.mobile;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.media.MediaScannerConnection;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;
import android.webkit.MimeTypeMap;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(
    name = "VaultMedia",
    permissions = {
        @Permission(
            alias = "mediaLegacy",
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE }
        ),
        @Permission(
            alias = "mediaScoped",
            strings = {
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.ACCESS_MEDIA_LOCATION
            }
        ),
        @Permission(
            alias = "media33",
            strings = {
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.ACCESS_MEDIA_LOCATION
            }
        ),
        @Permission(
            alias = "media34",
            strings = {
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO,
                Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
                Manifest.permission.ACCESS_MEDIA_LOCATION
            }
        ),
        @Permission(
            alias = "writeLegacy",
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class VaultMediaPlugin extends Plugin {
    private static final int MAX_SLICE_BYTES = 16 * 1024 * 1024;
    private static final int HASH_BUFFER_SIZE = 64 * 1024;

    private static final class AlbumAccum {
        final String id;
        final String name;
        int count = 0;

        AlbumAccum(String id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    private boolean isGranted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject evaluateMediaAccess() {
        boolean granted = false;
        String accessLevel = "denied";

        if (Build.VERSION.SDK_INT >= 34) {
            boolean hasImages = isGranted(Manifest.permission.READ_MEDIA_IMAGES);
            boolean hasVideo = isGranted(Manifest.permission.READ_MEDIA_VIDEO);
            boolean hasUserSelected = isGranted(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED);
            if (hasImages && hasVideo) {
                granted = true;
                accessLevel = "all";
            } else if (hasUserSelected || hasImages || hasVideo) {
                granted = true;
                accessLevel = "limited";
            }
        } else if (Build.VERSION.SDK_INT == Build.VERSION_CODES.TIRAMISU) {
            boolean hasImages = isGranted(Manifest.permission.READ_MEDIA_IMAGES);
            boolean hasVideo = isGranted(Manifest.permission.READ_MEDIA_VIDEO);
            if (hasImages && hasVideo) {
                granted = true;
                accessLevel = "all";
            } else if (hasImages || hasVideo) {
                granted = true;
                accessLevel = "limited";
            }
        } else {
            if (isGranted(Manifest.permission.READ_EXTERNAL_STORAGE)) {
                granted = true;
                accessLevel = "all";
            }
        }

        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("accessLevel", accessLevel);
        return result;
    }

    private String mediaAliasForSdk() {
        if (Build.VERSION.SDK_INT >= 34) {
            return "media34";
        }
        if (Build.VERSION.SDK_INT == Build.VERSION_CODES.TIRAMISU) {
            return "media33";
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return "mediaScoped";
        }
        return "mediaLegacy";
    }

    @PluginMethod
    public void getNetworkStatus(PluginCall call) {
        ConnectivityManager cm =
            (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        boolean connected = false;
        String type = "none";
        boolean isWifi = false;

        if (cm != null) {
            Network active = cm.getActiveNetwork();
            NetworkCapabilities caps = active != null ? cm.getNetworkCapabilities(active) : null;
            if (caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                connected = true;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                    type = "wifi";
                    isWifi = true;
                } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                    type = "cellular";
                } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) {
                    type = "ethernet";
                } else {
                    type = "unknown";
                }
            }
        }

        JSObject res = new JSObject();
        res.put("connected", connected);
        res.put("type", type);
        res.put("isWifi", isWifi);
        call.resolve(res);
    }

    @PluginMethod
    public void checkAndRequestMediaPermissions(PluginCall call) {
        JSObject current = evaluateMediaAccess();
        if (current.optBoolean("granted", false)) {
            call.resolve(current);
            return;
        }
        requestPermissionForAlias(mediaAliasForSdk(), call, "mediaPermissionsCallback");
    }

    @PermissionCallback
    private void mediaPermissionsCallback(PluginCall call) {
        call.resolve(evaluateMediaAccess());
    }

    private String buildBaseSelection() {
        StringBuilder sb = new StringBuilder();
        sb.append("(")
            .append(MediaStore.Files.FileColumns.MEDIA_TYPE).append(" = ? OR ")
            .append(MediaStore.Files.FileColumns.MEDIA_TYPE).append(" = ?")
            .append(") AND ")
            .append(MediaStore.MediaColumns.SIZE).append(" > 0");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            sb.append(" AND ").append(MediaStore.MediaColumns.IS_PENDING).append(" = 0");
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            sb.append(" AND ").append(MediaStore.MediaColumns.IS_TRASHED).append(" = 0");
        }
        return sb.toString();
    }

    @PluginMethod
    public void listDeviceAlbums(PluginCall call) {
        execute(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                Uri filesUri = MediaStore.Files.getContentUri("external");
                String[] projection = new String[] {
                    MediaStore.Files.FileColumns._ID,
                    MediaStore.Files.FileColumns.MEDIA_TYPE,
                    MediaStore.MediaColumns.BUCKET_ID,
                    MediaStore.MediaColumns.BUCKET_DISPLAY_NAME,
                    MediaStore.MediaColumns.SIZE
                };
                String selection = buildBaseSelection();
                String[] selectionArgs = new String[] {
                    String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE),
                    String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO)
                };

                Map<String, AlbumAccum> map = new LinkedHashMap<>();
                try (Cursor cursor = resolver.query(filesUri, projection, selection, selectionArgs, null)) {
                    if (cursor != null) {
                        int bucketIdIdx = cursor.getColumnIndex(MediaStore.MediaColumns.BUCKET_ID);
                        int bucketNameIdx = cursor.getColumnIndex(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME);
                        while (cursor.moveToNext()) {
                            String bId = bucketIdIdx >= 0 ? cursor.getString(bucketIdIdx) : null;
                            String bName = bucketNameIdx >= 0 ? cursor.getString(bucketNameIdx) : null;
                            if (bId == null || bId.isEmpty()) bId = "default";
                            if (bName == null || bName.isEmpty()) bName = "Thiết bị";
                            AlbumAccum acc = map.get(bId);
                            if (acc == null) {
                                acc = new AlbumAccum(bId, bName);
                                map.put(bId, acc);
                            }
                            acc.count += 1;
                        }
                    }
                }

                List<AlbumAccum> sorted = new ArrayList<>(map.values());
                Collections.sort(sorted, (a, b) -> Integer.compare(b.count, a.count));

                JSArray albums = new JSArray();
                for (AlbumAccum acc : sorted) {
                    JSObject obj = new JSObject();
                    obj.put("id", acc.id);
                    obj.put("name", acc.name);
                    obj.put("count", acc.count);
                    albums.put(obj);
                }

                JSObject result = new JSObject();
                result.put("albums", albums);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Không đọc được danh sách album thiết bị: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void scanDeviceMedia(PluginCall call) {
        String albumId = call.getString("albumId");
        int limit = Math.max(1, call.getInt("limit", 200));
        int offset = Math.max(0, call.getInt("offset", 0));

        execute(() -> {
            try {
                ContentResolver resolver = getContext().getContentResolver();
                Uri filesUri = MediaStore.Files.getContentUri("external");
                String[] projection = new String[] {
                    MediaStore.Files.FileColumns._ID,
                    MediaStore.Files.FileColumns.MEDIA_TYPE,
                    MediaStore.MediaColumns.DISPLAY_NAME,
                    MediaStore.MediaColumns.MIME_TYPE,
                    MediaStore.MediaColumns.SIZE,
                    MediaStore.MediaColumns.DATE_TAKEN,
                    MediaStore.MediaColumns.DATE_ADDED,
                    MediaStore.MediaColumns.WIDTH,
                    MediaStore.MediaColumns.HEIGHT,
                    MediaStore.MediaColumns.DURATION,
                    MediaStore.MediaColumns.BUCKET_ID,
                    MediaStore.MediaColumns.BUCKET_DISPLAY_NAME
                };

                StringBuilder selection = new StringBuilder(buildBaseSelection());
                List<String> argsList = new ArrayList<>();
                argsList.add(String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE));
                argsList.add(String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO));

                if ("default".equals(albumId)) {
                    String bucketColumn = MediaStore.MediaColumns.BUCKET_ID;
                    selection.append(" AND (").append(bucketColumn).append(" IS NULL OR ")
                        .append(bucketColumn).append(" = '')");
                } else if (albumId != null && !albumId.isEmpty() && !"all".equals(albumId)) {
                    selection.append(" AND ").append(MediaStore.MediaColumns.BUCKET_ID).append(" = ?");
                    argsList.add(albumId);
                }

                String sortOrder =
                    MediaStore.Files.FileColumns.DATE_ADDED + " DESC, " +
                    MediaStore.Files.FileColumns._ID + " DESC";

                SimpleDateFormat isoFmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
                isoFmt.setTimeZone(TimeZone.getTimeZone("UTC"));

                JSArray items = new JSArray();
                int total = 0;

                try (Cursor cursor = resolver.query(
                    filesUri,
                    projection,
                    selection.toString(),
                    argsList.toArray(new String[0]),
                    sortOrder
                )) {
                    if (cursor != null) {
                        total = cursor.getCount();
                        int idIdx = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID);
                        int typeIdx = cursor.getColumnIndexOrThrow(MediaStore.Files.FileColumns.MEDIA_TYPE);
                        int nameIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
                        int mimeIdx = cursor.getColumnIndex(MediaStore.MediaColumns.MIME_TYPE);
                        int sizeIdx = cursor.getColumnIndex(MediaStore.MediaColumns.SIZE);
                        int takenIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DATE_TAKEN);
                        int addedIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DATE_ADDED);
                        int widthIdx = cursor.getColumnIndex(MediaStore.MediaColumns.WIDTH);
                        int heightIdx = cursor.getColumnIndex(MediaStore.MediaColumns.HEIGHT);
                        int durationIdx = cursor.getColumnIndex(MediaStore.MediaColumns.DURATION);
                        int bucketIdIdx = cursor.getColumnIndex(MediaStore.MediaColumns.BUCKET_ID);
                        int bucketNameIdx = cursor.getColumnIndex(MediaStore.MediaColumns.BUCKET_DISPLAY_NAME);

                        if (offset < total && cursor.moveToPosition(offset)) {
                            do {
                                long rowId = cursor.getLong(idIdx);
                                int mediaType = cursor.getInt(typeIdx);
                                boolean isVideo = mediaType == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO;
                                String mediaKind = isVideo ? "video" : "image";

                                Uri contentUri = ContentUris.withAppendedId(
                                    isVideo
                                        ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                                        : MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                                    rowId
                                );
                                String uriStr = contentUri.toString();

                                String filename = nameIdx >= 0 ? cursor.getString(nameIdx) : null;
                                if (filename == null || filename.isEmpty()) {
                                    filename = (isVideo ? "video_" : "image_") + rowId + (isVideo ? ".mp4" : ".jpg");
                                }

                                String mimeType = mimeIdx >= 0 ? cursor.getString(mimeIdx) : null;
                                if (mimeType == null || mimeType.isEmpty()) {
                                    int dot = filename.lastIndexOf('.');
                                    if (dot > 0 && dot < filename.length() - 1) {
                                        String ext = filename.substring(dot + 1).toLowerCase(Locale.US);
                                        mimeType = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                                    }
                                    if (mimeType == null || mimeType.isEmpty()) {
                                        mimeType = isVideo ? "video/mp4" : "image/jpeg";
                                    }
                                }

                                long sizeBytes = sizeIdx >= 0 ? cursor.getLong(sizeIdx) : 0L;
                                long dateTaken = takenIdx >= 0 ? cursor.getLong(takenIdx) : 0L;
                                long dateAdded = addedIdx >= 0 ? cursor.getLong(addedIdx) : 0L;
                                long timestampMs = dateTaken > 0 ? dateTaken : (dateAdded > 0 ? dateAdded * 1000L : 0L);

                                int width = widthIdx >= 0 ? cursor.getInt(widthIdx) : 0;
                                int height = heightIdx >= 0 ? cursor.getInt(heightIdx) : 0;
                                long durationMs = durationIdx >= 0 ? cursor.getLong(durationIdx) : 0L;

                                String bId = bucketIdIdx >= 0 ? cursor.getString(bucketIdIdx) : null;
                                String bName = bucketNameIdx >= 0 ? cursor.getString(bucketNameIdx) : null;

                                JSObject item = new JSObject();
                                item.put("id", uriStr);
                                item.put("assetId", uriStr);
                                item.put("filename", filename);
                                item.put("mimeType", mimeType);
                                item.put("mediaKind", mediaKind);
                                item.put("sizeBytes", sizeBytes);
                                item.put("capturedAt", timestampMs > 0 ? isoFmt.format(new Date(timestampMs)) : JSONObject.NULL);
                                item.put("width", width > 0 ? width : JSONObject.NULL);
                                item.put("height", height > 0 ? height : JSONObject.NULL);
                                item.put("durationMs", (isVideo && durationMs > 0) ? durationMs : JSONObject.NULL);
                                item.put("albumId", (bId != null && !bId.isEmpty()) ? bId : "default");
                                item.put("albumName", (bName != null && !bName.isEmpty()) ? bName : "Thiết bị");
                                items.put(item);
                            } while (items.length() < limit && cursor.moveToNext());
                        }
                    }
                }

                JSObject res = new JSObject();
                res.put("items", items);
                res.put("total", total);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Không quét được thư viện ảnh/video: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void getAssetThumbnail(PluginCall call) {
        execute(() -> {
            Bitmap bitmap = null;
            try {
                Uri uri = parseValidatedMediaUri(call.getString("assetId"));
                ContentResolver resolver = getContext().getContentResolver();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    bitmap = resolver.loadThumbnail(uri, new Size(320, 320), null);
                } else if (uri.getPathSegments().contains("video")) {
                    bitmap = MediaStore.Video.Thumbnails.getThumbnail(
                        resolver, ContentUris.parseId(uri), MediaStore.Video.Thumbnails.MINI_KIND, null
                    );
                } else {
                    bitmap = MediaStore.Images.Thumbnails.getThumbnail(
                        resolver, ContentUris.parseId(uri), MediaStore.Images.Thumbnails.MINI_KIND, null
                    );
                }
                JSObject result = new JSObject();
                if (bitmap != null) {
                    ByteArrayOutputStream output = new ByteArrayOutputStream();
                    if (bitmap.compress(Bitmap.CompressFormat.JPEG, 78, output)) {
                        result.put("dataBase64", Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP));
                    }
                }
                call.resolve(result);
            } catch (Exception ignored) {
                call.resolve(new JSObject());
            } finally {
                if (bitmap != null) bitmap.recycle();
            }
        });
    }

    private Uri parseValidatedMediaUri(String assetId) {
        if (assetId == null || !assetId.startsWith("content://media/")) {
            throw new IllegalArgumentException("assetId không hợp lệ: " + assetId);
        }
        return Uri.parse(assetId);
    }

    private Uri toOriginalUri(Uri uri) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && isGranted(Manifest.permission.ACCESS_MEDIA_LOCATION)) {
            try {
                return MediaStore.setRequireOriginal(uri);
            } catch (SecurityException | UnsupportedOperationException ignored) {
                return uri;
            }
        }
        return uri;
    }

    private AssetFileDescriptor openOriginalDescriptor(Uri uri) throws Exception {
        ContentResolver resolver = getContext().getContentResolver();
        Uri originalUri = toOriginalUri(uri);
        try {
            AssetFileDescriptor afd = resolver.openAssetFileDescriptor(originalUri, "r");
            if (afd != null) {
                return afd;
            }
        } catch (SecurityException | UnsupportedOperationException ignored) {
            if (!originalUri.equals(uri)) {
                AssetFileDescriptor fallback = resolver.openAssetFileDescriptor(uri, "r");
                if (fallback != null) {
                    return fallback;
                }
            } else {
                throw ignored;
            }
        }
        throw new IllegalStateException("Không mở được tệp MediaStore: " + uri);
    }

    @PluginMethod
    public void computeAssetSha256(PluginCall call) {
        String assetId = call.getString("assetId");
        execute(() -> {
            try {
                Uri uri = parseValidatedMediaUri(assetId);
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long totalBytes = 0L;
                byte[] buffer = new byte[HASH_BUFFER_SIZE];

                try (AssetFileDescriptor afd = openOriginalDescriptor(uri);
                     InputStream is = afd.createInputStream()) {
                    int n;
                    while ((n = is.read(buffer)) != -1) {
                        if (n > 0) {
                            digest.update(buffer, 0, n);
                            totalBytes += n;
                        }
                    }
                }

                byte[] hash = digest.digest();
                StringBuilder hex = new StringBuilder(hash.length * 2);
                for (byte b : hash) {
                    hex.append(Character.forDigit((b >> 4) & 0xF, 16));
                    hex.append(Character.forDigit(b & 0xF, 16));
                }

                JSObject res = new JSObject();
                res.put("sha256", hex.toString());
                res.put("sizeBytes", totalBytes);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Lỗi tính SHA-256 tệp gốc: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void readAssetSlice(PluginCall call) {
        String assetId = call.getString("assetId");
        long offset = Math.max(0L, call.getData().optLong("offset", 0L));
        int requestedLength = call.getInt("length", 0);
        int length = Math.max(0, Math.min(MAX_SLICE_BYTES, requestedLength));

        execute(() -> {
            try {
                Uri uri = parseValidatedMediaUri(assetId);
                if (length == 0) {
                    JSObject empty = new JSObject();
                    empty.put("dataBase64", "");
                    empty.put("bytesRead", 0);
                    call.resolve(empty);
                    return;
                }

                byte[] buf = new byte[length];
                int totalRead = 0;

                try (AssetFileDescriptor afd = openOriginalDescriptor(uri);
                     FileInputStream fis = afd.createInputStream()) {
                    FileChannel channel = fis.getChannel();
                    long fileSize = channel.size();
                    if (fileSize >= 0 && offset >= fileSize) {
                        JSObject eofRes = new JSObject();
                        eofRes.put("dataBase64", "");
                        eofRes.put("bytesRead", 0);
                        call.resolve(eofRes);
                        return;
                    }
                    channel.position(offset);
                    ByteBuffer bb = ByteBuffer.wrap(buf);
                    while (bb.hasRemaining()) {
                        int n = channel.read(bb);
                        if (n <= 0) {
                            break;
                        }
                        totalRead += n;
                    }
                }

                String b64 = totalRead > 0 ? Base64.encodeToString(buf, 0, totalRead, Base64.NO_WRAP) : "";
                JSObject res = new JSObject();
                res.put("dataBase64", b64);
                res.put("bytesRead", totalRead);
                call.resolve(res);
            } catch (Exception e) {
                call.reject("Lỗi đọc đoạn tệp MediaStore: " + e.getMessage(), e);
            }
        });
    }

    @PluginMethod
    public void saveOriginalToGallery(PluginCall call) {
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String mediaKind = call.getString("mediaKind", "image");
        String dataBase64 = call.getString("dataBase64");

        if (filename == null || filename.trim().isEmpty() || dataBase64 == null) {
            call.reject("Thiếu filename hoặc dataBase64 để lưu vào thư viện.");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            !isGranted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
            requestPermissionForAlias("writeLegacy", call, "saveWritePermissionCallback");
            return;
        }

        performSaveOriginal(call, filename, mimeType, mediaKind, dataBase64);
    }

    @PermissionCallback
    private void saveWritePermissionCallback(PluginCall call) {
        if (!isGranted(Manifest.permission.WRITE_EXTERNAL_STORAGE)) {
            call.reject("Chưa được cấp quyền ghi bộ nhớ ngoài để lưu vào thư viện ảnh.");
            return;
        }
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String mediaKind = call.getString("mediaKind", "image");
        String dataBase64 = call.getString("dataBase64");
        if (filename == null || dataBase64 == null) {
            call.reject("Thiếu dữ liệu tải về để lưu.");
            return;
        }
        performSaveOriginal(call, filename, mimeType, mediaKind, dataBase64);
    }

    private static String resolveSaveMimeType(String filename, String rawMimeType, boolean isVideo) {
        String candidate = rawMimeType != null ? rawMimeType.trim() : "";
        if (candidate.isEmpty() || "application/octet-stream".equalsIgnoreCase(candidate)) {
            int dot = filename.lastIndexOf('.');
            if (dot >= 0 && dot < filename.length() - 1) {
                String ext = filename.substring(dot + 1).toLowerCase(Locale.US);
                String mapped = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                if (mapped != null && !mapped.trim().isEmpty()) {
                    candidate = mapped.trim();
                } else if ("heic".equals(ext)) {
                    candidate = "image/heic";
                } else if ("heif".equals(ext)) {
                    candidate = "image/heif";
                } else if ("dng".equals(ext)) {
                    candidate = "image/x-adobe-dng";
                } else if ("webp".equals(ext)) {
                    candidate = "image/webp";
                } else if ("mov".equals(ext)) {
                    candidate = "video/quicktime";
                } else if ("mkv".equals(ext)) {
                    candidate = "video/x-matroska";
                }
            }
        }
        if (candidate.isEmpty() || "application/octet-stream".equalsIgnoreCase(candidate)) {
            return isVideo ? "video/mp4" : "image/jpeg";
        }
        if (isVideo && !candidate.toLowerCase(Locale.US).startsWith("video/")) {
            return "video/mp4";
        }
        if (!isVideo && !candidate.toLowerCase(Locale.US).startsWith("image/")) {
            return "image/jpeg";
        }
        return candidate;
    }

    private void performSaveOriginal(
        PluginCall call,
        String filename,
        String mimeType,
        String mediaKind,
        String dataBase64
    ) {
        execute(() -> {
            try {
                byte[] bytes = Base64.decode(dataBase64, Base64.DEFAULT);
                String safeName = new File(filename).getName();
                boolean isVideo = "video".equalsIgnoreCase(mediaKind);
                String resolvedMimeType = resolveSaveMimeType(safeName, mimeType, isVideo);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentResolver resolver = getContext().getContentResolver();
                    Uri collection = isVideo
                        ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                        : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;

                    ContentValues values = new ContentValues();
                    values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
                    values.put(MediaStore.MediaColumns.MIME_TYPE, resolvedMimeType);
                    values.put(
                        MediaStore.MediaColumns.RELATIVE_PATH,
                        (isVideo ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES) + "/KhoAnh"
                    );
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);

                    Uri itemUri = resolver.insert(collection, values);
                    if (itemUri == null) {
                        call.reject("Không thể tạo mục mới trong MediaStore.");
                        return;
                    }

                    try (OutputStream os = resolver.openOutputStream(itemUri)) {
                        if (os == null) {
                            throw new IllegalStateException("openOutputStream returned null");
                        }
                        os.write(bytes);
                        os.flush();
                    } catch (Exception writeErr) {
                        resolver.delete(itemUri, null, null);
                        throw writeErr;
                    }

                    ContentValues completed = new ContentValues();
                    completed.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(itemUri, completed, null, null);

                    JSObject res = new JSObject();
                    res.put("saved", true);
                    res.put("assetId", itemUri.toString());
                    call.resolve(res);
                } else {
                    File baseDir = Environment.getExternalStoragePublicDirectory(
                        isVideo ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES
                    );
                    File targetDir = new File(baseDir, "KhoAnh");
                    if (!targetDir.exists() && !targetDir.mkdirs()) {
                        call.reject("Không tạo được thư mục KhoAnh trong bộ nhớ thiết bị.");
                        return;
                    }
                    File outFile = new File(targetDir, safeName);
                    if (outFile.exists()) {
                        String prefix = String.valueOf(System.currentTimeMillis());
                        outFile = new File(targetDir, prefix + "_" + safeName);
                    }
                    try (FileOutputStream fos = new FileOutputStream(outFile)) {
                        fos.write(bytes);
                        fos.flush();
                    }

                    final File finalOutFile = outFile;
                    final String[] scannedHolder = new String[1];
                    CountDownLatch latch = new CountDownLatch(1);
                    MediaScannerConnection.scanFile(
                        getContext(),
                        new String[] { finalOutFile.getAbsolutePath() },
                        new String[] { resolvedMimeType },
                        (path, uri) -> {
                            scannedHolder[0] = uri != null ? uri.toString() : Uri.fromFile(finalOutFile).toString();
                            latch.countDown();
                        }
                    );
                    latch.await(5, TimeUnit.SECONDS);

                    JSObject res = new JSObject();
                    res.put("saved", true);
                    res.put("assetId", scannedHolder[0] != null ? scannedHolder[0] : Uri.fromFile(finalOutFile).toString());
                    call.resolve(res);
                }
            } catch (Exception e) {
                call.reject("Lỗi lưu tệp gốc vào thư viện: " + e.getMessage(), e);
            }
        });
    }
}
