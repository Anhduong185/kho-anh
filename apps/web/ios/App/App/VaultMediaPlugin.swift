import Foundation
import Capacitor
import Photos
import Network
import CryptoKit
import UniformTypeIdentifiers
import UIKit

@objc(VaultMediaPlugin)
public class VaultMediaPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VaultMediaPlugin"
    public let jsName = "VaultMedia"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getNetworkStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkAndRequestMediaPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDeviceAlbums", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanDeviceMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAssetThumbnail", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "computeAssetSha256", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readAssetSlice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveOriginalToGallery", returnType: CAPPluginReturnPromise)
    ]

    private static let maxSliceBytes = 16 * 1024 * 1024

    private let ioQueue = DispatchQueue(label: "com.vaultphotos.mobile.media", qos: .userInitiated)
    private let monitorQueue = DispatchQueue(label: "com.vaultphotos.mobile.network", qos: .utility)
    private let pathLock = NSLock()
    private var pathMonitor: NWPathMonitor?
    private var latestPath: NWPath?
    private let initialPathSemaphore = DispatchSemaphore(value: 0)
    private var didSignalInitialPath = false

    private let cacheLock = NSLock()
    private var cachedAssetId: String?
    private var cachedFileURL: URL?
    private var cachedFileSize: Int64 = 0

    override public func load() {
        super.load()
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            self.pathLock.lock()
            self.latestPath = path
            let shouldSignal = !self.didSignalInitialPath
            self.didSignalInitialPath = true
            self.pathLock.unlock()
            if shouldSignal {
                self.initialPathSemaphore.signal()
            }
        }
        monitor.start(queue: monitorQueue)
        pathMonitor = monitor
    }

    deinit {
        pathMonitor?.cancel()
        clearCachedAssetFile()
    }

    private func clearCachedAssetFile() {
        cacheLock.lock()
        let oldUrl = cachedFileURL
        cachedAssetId = nil
        cachedFileURL = nil
        cachedFileSize = 0
        cacheLock.unlock()

        if let oldUrl = oldUrl {
            try? FileManager.default.removeItem(at: oldUrl)
        }
    }

    @objc func getNetworkStatus(_ call: CAPPluginCall) {
        pathLock.lock()
        var current = latestPath
        pathLock.unlock()

        if current == nil {
            _ = initialPathSemaphore.wait(timeout: .now() + 0.25)
            pathLock.lock()
            current = latestPath
            pathLock.unlock()
        }

        guard let path = current else {
            call.resolve([
                "connected": false,
                "type": "unknown",
                "isWifi": false
            ])
            return
        }

        let connected = path.status == .satisfied
        let type: String
        let isWifi: Bool

        if !connected {
            type = "none"
            isWifi = false
        } else if path.usesInterfaceType(.wifi) {
            type = "wifi"
            isWifi = true
        } else if path.usesInterfaceType(.cellular) {
            type = "cellular"
            isWifi = false
        } else if path.usesInterfaceType(.wiredEthernet) {
            type = "ethernet"
            isWifi = false
        } else {
            type = "unknown"
            isWifi = false
        }

        call.resolve([
            "connected": connected,
            "type": type,
            "isWifi": isWifi
        ])
    }

    private func mapAuthorizationStatus(_ status: PHAuthorizationStatus) -> (Bool, String) {
        switch status {
        case .authorized:
            return (true, "all")
        case .limited:
            return (true, "limited")
        default:
            return (false, "denied")
        }
    }

    @objc func checkAndRequestMediaPermissions(_ call: CAPPluginCall) {
        let current = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if current != .notDetermined {
            let (granted, accessLevel) = mapAuthorizationStatus(current)
            call.resolve([
                "granted": granted,
                "accessLevel": accessLevel
            ])
            return
        }

        PHPhotoLibrary.requestAuthorization(for: .readWrite) { [weak self] status in
            guard let self = self else { return }
            let (granted, accessLevel) = self.mapAuthorizationStatus(status)
            call.resolve([
                "granted": granted,
                "accessLevel": accessLevel
            ])
        }
    }

    private func mediaFetchOptions() -> PHFetchOptions {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(
            format: "mediaType == %d || mediaType == %d",
            PHAssetMediaType.image.rawValue,
            PHAssetMediaType.video.rawValue
        )
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        return options
    }

    @objc func listDeviceAlbums(_ call: CAPPluginCall) {
        ioQueue.async { [weak self] in
            guard let self = self else { return }
            var albums: [[String: Any]] = []
            var seenIds = Set<String>()
            let fetchOptions = self.mediaFetchOptions()

            let smartAlbums = PHAssetCollection.fetchAssetCollections(
                with: .smartAlbum,
                subtype: .any,
                options: nil
            )
            let userAlbums = PHAssetCollection.fetchAssetCollections(
                with: .album,
                subtype: .any,
                options: nil
            )

            let collections: [PHFetchResult<PHAssetCollection>] = [smartAlbums, userAlbums]
            for result in collections {
                result.enumerateObjects { collection, _, _ in
                    let colId = collection.localIdentifier
                    if seenIds.contains(colId) {
                        return
                    }
                    let assets = PHAsset.fetchAssets(in: collection, options: fetchOptions)
                    if assets.count > 0 {
                        seenIds.insert(colId)
                        albums.append([
                            "id": colId,
                            "name": collection.localizedTitle ?? "Album",
                            "count": assets.count
                        ])
                    }
                }
            }

            albums.sort { lhs, rhs in
                let lc = lhs["count"] as? Int ?? 0
                let rc = rhs["count"] as? Int ?? 0
                return lc > rc
            }

            call.resolve(["albums": albums])
        }
    }

    private func selectOriginalResource(for asset: PHAsset) -> PHAssetResource? {
        let resources = PHAssetResource.assetResources(for: asset)
        if asset.mediaType == .video {
            return resources.first(where: { $0.type == .video })
                ?? resources.first(where: { $0.type == .pairedVideo })
                ?? resources.first(where: { $0.type == .fullSizeVideo })
                ?? resources.first
        }
        return resources.first(where: { $0.type == .photo })
            ?? resources.first(where: { $0.type == .alternatePhoto })
            ?? resources.first(where: { $0.type == .fullSizePhoto })
            ?? resources.first
    }

    private func buildAssetAlbumLookup() -> [String: (id: String, name: String)] {
        var lookup: [String: (id: String, name: String)] = [:]
        let fetchOptions = mediaFetchOptions()
        let userAlbums = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: nil)
        userAlbums.enumerateObjects { collection, _, _ in
            let colId = collection.localIdentifier
            let colName = collection.localizedTitle ?? "Album"
            let assets = PHAsset.fetchAssets(in: collection, options: fetchOptions)
            assets.enumerateObjects { asset, _, _ in
                if lookup[asset.localIdentifier] == nil {
                    lookup[asset.localIdentifier] = (colId, colName)
                }
            }
        }
        return lookup
    }

    private func formatIsoDate(_ date: Date?) -> Any {
        guard let date = date else { return NSNull() }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    @objc func scanDeviceMedia(_ call: CAPPluginCall) {
        let albumId = call.getString("albumId")
        let limit = max(1, call.getInt("limit") ?? 200)
        let offset = max(0, call.getInt("offset") ?? 0)

        ioQueue.async { [weak self] in
            guard let self = self else { return }
            let fetchOptions = self.mediaFetchOptions()
            let assetsResult: PHFetchResult<PHAsset>
            var fixedAlbumName: String?

            if let albumId = albumId, !albumId.isEmpty, albumId != "all" {
                let cols = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [albumId], options: nil)
                if let col = cols.firstObject {
                    fixedAlbumName = col.localizedTitle ?? "Album"
                    assetsResult = PHAsset.fetchAssets(in: col, options: fetchOptions)
                } else {
                    call.resolve(["items": [], "total": 0])
                    return
                }
            } else {
                assetsResult = PHAsset.fetchAssets(with: fetchOptions)
            }

            let total = assetsResult.count
            if offset >= total {
                call.resolve(["items": [], "total": total])
                return
            }

            let albumLookup = fixedAlbumName == nil ? self.buildAssetAlbumLookup() : [:]
            let endIdx = min(total, offset + limit)
            var items: [[String: Any]] = []

            for idx in offset..<endIdx {
                let asset = assetsResult.object(at: idx)
                let isVideo = asset.mediaType == .video
                let resource = self.selectOriginalResource(for: asset)
                let filename = resource?.originalFilename ?? (isVideo ? "video_\(idx).mp4" : "image_\(idx).jpg")
                let mimeType: String
                if let uti = resource?.uniformTypeIdentifier,
                   let preferred = UTType(uti)?.preferredMIMEType {
                    mimeType = preferred
                } else {
                    mimeType = isVideo ? "video/mp4" : "image/jpeg"
                }

                let sizeBytes = (resource?.value(forKey: "fileSize") as? NSNumber)?.int64Value ?? 0
                let assetId = asset.localIdentifier
                let resolvedAlbumId: String
                let resolvedAlbumName: String
                if let fixedName = fixedAlbumName, let requestedAlbumId = albumId {
                    resolvedAlbumId = requestedAlbumId
                    resolvedAlbumName = fixedName
                } else if let mapped = albumLookup[assetId] {
                    resolvedAlbumId = mapped.id
                    resolvedAlbumName = mapped.name
                } else {
                    resolvedAlbumId = "camera-roll"
                    resolvedAlbumName = "Thư viện Ảnh"
                }

                var entry: [String: Any] = [
                    "id": assetId,
                    "assetId": assetId,
                    "filename": filename,
                    "mimeType": mimeType,
                    "mediaKind": isVideo ? "video" : "image",
                    "sizeBytes": sizeBytes,
                    "capturedAt": self.formatIsoDate(asset.creationDate),
                    "width": asset.pixelWidth > 0 ? asset.pixelWidth : NSNull(),
                    "height": asset.pixelHeight > 0 ? asset.pixelHeight : NSNull(),
                    "durationMs": (isVideo && asset.duration > 0) ? Int64(asset.duration * 1000.0) : NSNull(),
                    "albumId": resolvedAlbumId,
                    "albumName": resolvedAlbumName
                ]
                if entry["capturedAt"] == nil {
                    entry["capturedAt"] = NSNull()
                }
                items.append(entry)
            }

            call.resolve([
                "items": items,
                "total": total
            ])
        }
    }

    @objc func getAssetThumbnail(_ call: CAPPluginCall) {
        guard let assetId = call.getString("assetId"),
              let asset = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil).firstObject else {
            call.resolve()
            return
        }

        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = false
        PHImageManager.default().requestImage(
            for: asset, targetSize: CGSize(width: 320, height: 320), contentMode: .aspectFill, options: options
        ) { image, _ in
            if let data = image?.jpegData(compressionQuality: 0.78) {
                call.resolve(["dataBase64": data.base64EncodedString()])
            } else {
                call.resolve()
            }
        }
    }

    private func fetchOriginalResource(assetId: String) throws -> PHAssetResource {
        let fetched = PHAsset.fetchAssets(withLocalIdentifiers: [assetId], options: nil)
        guard let asset = fetched.firstObject else {
            throw NSError(domain: "VaultMedia", code: 404, userInfo: [NSLocalizedDescriptionKey: "Không tìm thấy tệp trong Thư viện Ảnh."])
        }
        guard let resource = selectOriginalResource(for: asset) else {
            throw NSError(domain: "VaultMedia", code: 404, userInfo: [NSLocalizedDescriptionKey: "Không tìm thấy tài nguyên gốc cho tệp."])
        }
        return resource
    }

    @objc func computeAssetSha256(_ call: CAPPluginCall) {
        guard let assetId = call.getString("assetId"), !assetId.isEmpty else {
            call.reject("Thiếu assetId.")
            return
        }

        ioQueue.async { [weak self] in
            guard let self = self else { return }
            do {
                let resource = try self.fetchOriginalResource(assetId: assetId)
                let options = PHAssetResourceRequestOptions()
                options.isNetworkAccessAllowed = true

                var hasher = SHA256()
                var totalBytes: Int64 = 0
                var requestErr: Error?
                let semaphore = DispatchSemaphore(value: 0)

                PHAssetResourceManager.default().requestData(
                    for: resource,
                    options: options,
                    dataReceivedHandler: { chunk in
                        hasher.update(data: chunk)
                        totalBytes += Int64(chunk.count)
                    },
                    completionHandler: { error in
                        requestErr = error
                        semaphore.signal()
                    }
                )
                semaphore.wait()

                if let err = requestErr {
                    call.reject("Lỗi đọc dữ liệu gốc từ Photos: \(err.localizedDescription)", nil, err)
                    return
                }

                let digest = hasher.finalize()
                let hex = digest.map { String(format: "%02x", $0) }.joined()
                call.resolve([
                    "sha256": hex,
                    "sizeBytes": totalBytes
                ])
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    private func ensureCachedFile(for assetId: String) throws -> (URL, Int64) {
        cacheLock.lock()
        if cachedAssetId == assetId,
           let url = cachedFileURL,
           FileManager.default.fileExists(atPath: url.path) {
            let size = cachedFileSize
            cacheLock.unlock()
            return (url, size)
        }
        cacheLock.unlock()

        clearCachedAssetFile()

        let resource = try fetchOriginalResource(assetId: assetId)
        let tempUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent("vault_slice_\(UUID().uuidString)")
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true

        var writeErr: Error?
        let semaphore = DispatchSemaphore(value: 0)
        PHAssetResourceManager.default().writeData(for: resource, toFile: tempUrl, options: options) { error in
            writeErr = error
            semaphore.signal()
        }
        semaphore.wait()

        if let err = writeErr {
            try? FileManager.default.removeItem(at: tempUrl)
            throw err
        }

        let attrs = try FileManager.default.attributesOfItem(atPath: tempUrl.path)
        let fileSize = (attrs[.size] as? NSNumber)?.int64Value ?? 0

        cacheLock.lock()
        cachedAssetId = assetId
        cachedFileURL = tempUrl
        cachedFileSize = fileSize
        cacheLock.unlock()

        return (tempUrl, fileSize)
    }

    @objc func readAssetSlice(_ call: CAPPluginCall) {
        guard let assetId = call.getString("assetId"), !assetId.isEmpty else {
            call.reject("Thiếu assetId.")
            return
        }
        let offset = max(0, Int64(call.getInt("offset") ?? 0))
        let requestedLength = call.getInt("length") ?? 0
        let length = max(0, min(VaultMediaPlugin.maxSliceBytes, requestedLength))

        ioQueue.async { [weak self] in
            guard let self = self else { return }
            do {
                if length == 0 {
                    call.resolve(["dataBase64": "", "bytesRead": 0])
                    return
                }

                let (fileUrl, fileSize) = try self.ensureCachedFile(for: assetId)
                if offset >= fileSize {
                    self.clearCachedAssetFile()
                    call.resolve(["dataBase64": "", "bytesRead": 0])
                    return
                }

                let handle = try FileHandle(forReadingFrom: fileUrl)
                defer { try? handle.close() }
                try handle.seek(toOffset: UInt64(offset))
                let data = try handle.read(upToCount: length) ?? Data()

                if offset + Int64(data.count) >= fileSize {
                    self.clearCachedAssetFile()
                }

                call.resolve([
                    "dataBase64": data.base64EncodedString(),
                    "bytesRead": data.count
                ])
            } catch {
                self.clearCachedAssetFile()
                call.reject("Lỗi đọc đoạn tệp Photos: \(error.localizedDescription)", nil, error)
            }
        }
    }

    @objc func saveOriginalToGallery(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename"), !filename.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let dataBase64 = call.getString("dataBase64") else {
            call.reject("Thiếu filename hoặc dataBase64.")
            return
        }
        let mediaKind = call.getString("mediaKind") ?? "image"

        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if status == .notDetermined {
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { [weak self] nextStatus in
                if nextStatus == .authorized || nextStatus == .limited {
                    self?.performSaveToPhotos(call: call, filename: filename, mediaKind: mediaKind, dataBase64: dataBase64)
                } else {
                    call.reject("Chưa được cấp quyền lưu vào Thư viện Ảnh.")
                }
            }
            return
        }

        if status != .authorized && status != .limited {
            call.reject("Chưa được cấp quyền lưu vào Thư viện Ảnh.")
            return
        }

        performSaveToPhotos(call: call, filename: filename, mediaKind: mediaKind, dataBase64: dataBase64)
    }

    private func performSaveToPhotos(
        call: CAPPluginCall,
        filename: String,
        mediaKind: String,
        dataBase64: String
    ) {
        ioQueue.async {
            guard let data = Data(base64Encoded: dataBase64, options: .ignoreUnknownCharacters) else {
                call.reject("Dữ liệu base64 không hợp lệ.")
                return
            }

            let safeName = URL(fileURLWithPath: filename).lastPathComponent
            let tempDir = FileManager.default.temporaryDirectory
                .appendingPathComponent("vault_save_\(UUID().uuidString)", isDirectory: true)
            let tempFile = tempDir.appendingPathComponent(safeName)

            do {
                try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
                try data.write(to: tempFile, options: .atomic)
            } catch {
                try? FileManager.default.removeItem(at: tempDir)
                call.reject("Không ghi được tệp tạm: \(error.localizedDescription)", nil, error)
                return
            }

            let isVideo = mediaKind.lowercased() == "video"
            var placeholderId: String?

            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = safeName
                options.shouldMoveFile = true
                request.addResource(with: isVideo ? .video : .photo, fileURL: tempFile, options: options)
                placeholderId = request.placeholderForCreatedAsset?.localIdentifier
            }, completionHandler: { success, error in
                try? FileManager.default.removeItem(at: tempDir)
                if success {
                    var res: [String: Any] = ["saved": true]
                    if let assetId = placeholderId {
                        res["assetId"] = assetId
                    }
                    call.resolve(res)
                } else {
                    call.reject(
                        "Không thể lưu vào Thư viện Ảnh: \(error?.localizedDescription ?? "Lỗi không xác định")",
                        nil,
                        error
                    )
                }
            })
        }
    }
}
