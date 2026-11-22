import crypto from 'node:crypto';
import http from 'node:http';

export interface StoredMockObject {
  body: Buffer;
  contentType: string;
  metadata: Record<string, string>;
  etag: string;
}

export interface MockCloudServers {
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Objects: Map<string, StoredMockObject>;
  s3Requests: Array<{ method: string; url: string }>;
  webdavEndpoint: string;
  webdavUsername: string;
  webdavPassword: string;
  webdavObjects: Map<string, StoredMockObject>;
  webdavRequests: Array<{ method: string; url: string }>;
  close: () => Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function escapeXml(val: string): string {
  return val
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function listenOnLocalhost(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind mock server'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function buildCanonicalQuery(rawQuery: string, excludeKey?: string): string {
  if (!rawQuery) return '';
  const pairs: Array<[string, string]> = [];
  for (const part of rawQuery.split('&')) {
    if (!part) continue;
    const eqIdx = part.indexOf('=');
    const rawKey = eqIdx === -1 ? part : part.slice(0, eqIdx);
    const rawVal = eqIdx === -1 ? '' : part.slice(eqIdx + 1);
    const decodedKey = decodeURIComponent(rawKey);
    if (excludeKey && decodedKey === excludeKey) continue;
    const decodedVal = decodeURIComponent(rawVal);
    pairs.push([encodeRfc3986(decodedKey), encodeRfc3986(decodedVal)]);
  }
  pairs.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function verifySigV4Request(opts: {
  method: string;
  rawUrl: string;
  headers: http.IncomingHttpHeaders;
  rawBody: Buffer;
  expectedAccessKey: string;
  expectedSecretKey: string;
}): { ok: true } | { ok: false; code: string; message: string } {
  const qIdx = opts.rawUrl.indexOf('?');
  const canonicalUri = (qIdx === -1 ? opts.rawUrl : opts.rawUrl.slice(0, qIdx)) || '/';
  const rawQuery = qIdx === -1 ? '' : opts.rawUrl.slice(qIdx + 1);
  const parsedParams = new URLSearchParams(rawQuery);

  const authHeader = typeof opts.headers['authorization'] === 'string' ? opts.headers['authorization'].trim() : '';
  const querySig = parsedParams.get('X-Amz-Signature');

  let credentialRaw = '';
  let signedHeadersRaw = '';
  let providedSig = '';
  let amzDate = '';
  let canonicalQuery = '';
  let payloadHash = '';

  if (authHeader) {
    if (!authHeader.startsWith('AWS4-HMAC-SHA256 ')) {
      return { ok: false, code: 'AccessDenied', message: 'Unsupported authorization scheme' };
    }
    const credMatch = authHeader.match(/Credential=([^,\s]+)/);
    const shMatch = authHeader.match(/SignedHeaders=([^,\s]+)/);
    const sigMatch = authHeader.match(/Signature=([0-9a-fA-F]+)/);
    if (!credMatch || !shMatch || !sigMatch) {
      return { ok: false, code: 'AuthorizationHeaderMalformed', message: 'Malformed SigV4 Authorization header' };
    }
    credentialRaw = credMatch[1]!;
    signedHeadersRaw = shMatch[1]!;
    providedSig = sigMatch[1]!.toLowerCase();
    amzDate = String(opts.headers['x-amz-date'] ?? opts.headers['date'] ?? '').trim();
    canonicalQuery = buildCanonicalQuery(rawQuery);

    const actualBodyHash = crypto.createHash('sha256').update(opts.rawBody).digest('hex');
    const hdrPayloadHash =
      typeof opts.headers['x-amz-content-sha256'] === 'string'
        ? opts.headers['x-amz-content-sha256'].trim()
        : '';
    if (hdrPayloadHash === 'UNSIGNED-PAYLOAD' || hdrPayloadHash === 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD') {
      payloadHash = hdrPayloadHash;
    } else if (hdrPayloadHash) {
      if (hdrPayloadHash.toLowerCase() !== actualBodyHash) {
        return { ok: false, code: 'XAmzContentSHA256Mismatch', message: 'x-amz-content-sha256 mismatch' };
      }
      payloadHash = hdrPayloadHash.toLowerCase();
    } else {
      payloadHash = actualBodyHash;
    }
  } else if (querySig) {
    credentialRaw = parsedParams.get('X-Amz-Credential') ?? '';
    signedHeadersRaw = parsedParams.get('X-Amz-SignedHeaders') ?? '';
    providedSig = querySig.trim().toLowerCase();
    amzDate = (parsedParams.get('X-Amz-Date') ?? '').trim();
    canonicalQuery = buildCanonicalQuery(rawQuery, 'X-Amz-Signature');
    payloadHash = 'UNSIGNED-PAYLOAD';
    if (!credentialRaw || !signedHeadersRaw || !amzDate) {
      return { ok: false, code: 'AuthorizationQueryParametersError', message: 'Missing SigV4 query parameters' };
    }
  } else {
    return { ok: false, code: 'AccessDenied', message: 'Missing Authorization header' };
  }

  const credParts = credentialRaw.split('/');
  if (credParts.length !== 5) {
    return { ok: false, code: 'AuthorizationHeaderMalformed', message: 'Invalid Credential scope format' };
  }
  const [accessKey, dateStamp, region, service, terminator] = credParts as [
    string,
    string,
    string,
    string,
    string
  ];
  if (accessKey !== opts.expectedAccessKey) {
    return { ok: false, code: 'InvalidAccessKeyId', message: 'Access key mismatch' };
  }
  if (service !== 's3' || terminator !== 'aws4_request' || !amzDate) {
    return { ok: false, code: 'AuthorizationHeaderMalformed', message: 'Invalid Credential scope' };
  }

  const signedHeaderNames = signedHeadersRaw
    .split(';')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (signedHeaderNames.length === 0) {
    return { ok: false, code: 'AuthorizationHeaderMalformed', message: 'Missing SignedHeaders' };
  }

  const canonicalHeaders = signedHeaderNames
    .map((name) => {
      const rawVal = opts.headers[name];
      const strVal = Array.isArray(rawVal) ? rawVal.join(',') : String(rawVal ?? '');
      const normalized = strVal.trim().replace(/\s+/g, ' ');
      return `${name}:${normalized}\n`;
    })
    .join('');

  const canonicalRequest = [
    opts.method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash
  ].join('\n');

  const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, canonicalRequestHash].join('\n');

  const kDate = crypto.createHmac('sha256', `AWS4${opts.expectedSecretKey}`).update(dateStamp, 'utf8').digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region, 'utf8').digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service, 'utf8').digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request', 'utf8').digest();
  const expectedSig = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const providedBuf = Buffer.from(providedSig, 'utf8');
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return {
      ok: false,
      code: 'SignatureDoesNotMatch',
      message: 'The request signature we calculated does not match the signature you provided.'
    };
  }

  return { ok: true };
}

export async function startMockCloudServers(opts?: {
  s3AccessKey?: string;
  s3SecretKey?: string;
  webdavUsername?: string;
  webdavPassword?: string;
}): Promise<MockCloudServers> {
  const s3AccessKey = opts?.s3AccessKey ?? 'e2e-s3-access-key';
  const s3SecretKey = opts?.s3SecretKey ?? 'e2e-s3-secret-key';
  const webdavUsername = opts?.webdavUsername ?? 'e2e-dav-user';
  const webdavPassword = opts?.webdavPassword ?? 'e2e-dav-pass';

  // ==================== 1. MOCK S3 HTTP SERVER (Path-Style + Multipart XML) ====================
  const s3Objects = new Map<string, StoredMockObject>();
  const s3Uploads = new Map<
    string,
    { objectKey: string; contentType: string; parts: Map<number, { body: Buffer; etag: string }> }
  >();
  const s3Requests: Array<{ method: string; url: string }> = [];

  const s3Server = http.createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    const rawBody = await readBody(req);
    s3Requests.push({ method, url: rawUrl });

    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    const cleanPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    const slashIdx = cleanPath.indexOf('/');
    const bucket = slashIdx === -1 ? cleanPath : cleanPath.slice(0, slashIdx);
    const key = slashIdx === -1 ? '' : cleanPath.slice(slashIdx + 1);
    const fullKey = `${bucket}/${key}`;

    // Verify AWS4-HMAC-SHA256 Authorization / presigned X-Amz-Signature against s3AccessKey & s3SecretKey
    const authResult = verifySigV4Request({
      method,
      rawUrl,
      headers: req.headers,
      rawBody,
      expectedAccessKey: s3AccessKey,
      expectedSecretKey: s3SecretKey
    });
    if (!authResult.ok) {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end(
        `<Error><Code>${escapeXml(authResult.code)}</Code><Message>${escapeXml(authResult.message)}</Message></Error>`
      );
      return;
    }

    // Bucket-level operations
    if (!key) {
      if (method === 'HEAD' || method === 'PUT') {
        res.writeHead(200);
        res.end();
        return;
      }
      if (method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(`<ListBucketResult><Name>${escapeXml(bucket)}</Name></ListBucketResult>`);
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    const isInitiateMultipart = parsed.searchParams.has('uploads');
    const uploadId = parsed.searchParams.get('uploadId');
    const partNumberStr = parsed.searchParams.get('partNumber');

    if (method === 'POST' && isInitiateMultipart) {
      const id = crypto.randomUUID().replace(/-/g, '');
      s3Uploads.set(id, {
        objectKey: fullKey,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        parts: new Map()
      });
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<InitiateMultipartUploadResult>` +
          `<Bucket>${escapeXml(bucket)}</Bucket>` +
          `<Key>${escapeXml(key)}</Key>` +
          `<UploadId>${id}</UploadId>` +
          `</InitiateMultipartUploadResult>`
      );
      return;
    }

    if (method === 'PUT' && uploadId && partNumberStr) {
      const session = s3Uploads.get(uploadId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      const etag = crypto.createHash('md5').update(rawBody).digest('hex');
      session.parts.set(Number(partNumberStr), { body: rawBody, etag });
      res.writeHead(200, { ETag: `"${etag}"` });
      res.end();
      return;
    }

    if (method === 'POST' && uploadId) {
      const session = s3Uploads.get(uploadId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      const ordered = [...session.parts.entries()].sort((a, b) => a[0] - b[0]);
      const assembled = Buffer.concat(ordered.map(([, p]) => p.body));
      const etag = crypto.createHash('md5').update(assembled).digest('hex');
      const sha256 = crypto.createHash('sha256').update(assembled).digest('hex');
      s3Objects.set(session.objectKey, {
        body: assembled,
        contentType: session.contentType,
        metadata: { 'x-amz-meta-sha256': sha256 },
        etag
      });
      s3Uploads.delete(uploadId);
      res.writeHead(200, { 'Content-Type': 'application/xml', ETag: `"${etag}"` });
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?>` +
          `<CompleteMultipartUploadResult>` +
          `<Bucket>${escapeXml(bucket)}</Bucket>` +
          `<Key>${escapeXml(key)}</Key>` +
          `<ETag>"${etag}"</ETag>` +
          `</CompleteMultipartUploadResult>`
      );
      return;
    }

    if (method === 'DELETE' && uploadId) {
      s3Uploads.delete(uploadId);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'PUT') {
      const body = rawBody;
      const etag = crypto.createHash('md5').update(body).digest('hex');
      const metadata: Record<string, string> = {};
      for (const [hdrKey, hdrVal] of Object.entries(req.headers)) {
        if (hdrKey.toLowerCase().startsWith('x-amz-meta-') && typeof hdrVal === 'string') {
          metadata[hdrKey.toLowerCase()] = hdrVal;
        }
      }
      s3Objects.set(fullKey, {
        body,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        metadata,
        etag
      });
      res.writeHead(200, { ETag: `"${etag}"` });
      res.end();
      return;
    }

    if (method === 'HEAD') {
      const obj = s3Objects.get(fullKey);
      if (!obj) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(obj.body.length),
        'Content-Type': obj.contentType,
        ETag: `"${obj.etag}"`,
        ...obj.metadata
      });
      res.end();
      return;
    }

    if (method === 'GET') {
      const obj = s3Objects.get(fullKey);
      if (!obj) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(obj.body.length),
        'Content-Type': obj.contentType,
        ETag: `"${obj.etag}"`,
        ...obj.metadata
      });
      res.end(obj.body);
      return;
    }

    if (method === 'DELETE') {
      s3Objects.delete(fullKey);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  // ==================== 2. MOCK WEBDAV HTTP SERVER (Basic Auth + MKCOL/PROPFIND/CRUD) ====================
  const webdavObjects = new Map<string, StoredMockObject>();
  const webdavDirs = new Set<string>(['/']);
  const webdavRequests: Array<{ method: string; url: string }> = [];
  const expectedAuth = `Basic ${Buffer.from(`${webdavUsername}:${webdavPassword}`, 'utf8').toString('base64')}`;

  const webdavServer = http.createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    webdavRequests.push({ method, url: rawUrl });

    if (req.headers['authorization'] !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MockWebDAV"' });
      res.end('Unauthorized');
      return;
    }

    const parsed = new URL(rawUrl, 'http://127.0.0.1');
    const normPath = decodeURIComponent(parsed.pathname).replace(/\/+$/, '') || '/';

    if (method === 'MKCOL') {
      await readBody(req);
      if (webdavDirs.has(normPath)) {
        res.writeHead(405);
        res.end();
        return;
      }
      webdavDirs.add(normPath);
      res.writeHead(201);
      res.end();
      return;
    }

    if (method === 'PROPFIND') {
      await readBody(req);
      res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(
        `<?xml version="1.0" encoding="utf-8"?>` +
          `<D:multistatus xmlns:D="DAV:">` +
          `<D:response><D:href>${escapeXml(normPath)}</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>` +
          `</D:multistatus>`
      );
      return;
    }

    if (method === 'PUT') {
      const body = await readBody(req);
      const etag = crypto.createHash('md5').update(body).digest('hex');
      webdavObjects.set(normPath, {
        body,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        metadata: {},
        etag
      });
      res.writeHead(201, { ETag: `"${etag}"` });
      res.end();
      return;
    }

    if (method === 'HEAD') {
      const obj = webdavObjects.get(normPath);
      if (!obj) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(obj.body.length),
        'Content-Type': obj.contentType,
        ETag: `"${obj.etag}"`
      });
      res.end();
      return;
    }

    if (method === 'GET') {
      const obj = webdavObjects.get(normPath);
      if (!obj) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(obj.body.length),
        'Content-Type': obj.contentType,
        ETag: `"${obj.etag}"`
      });
      res.end(obj.body);
      return;
    }

    if (method === 'DELETE') {
      const existed = webdavObjects.delete(normPath);
      res.writeHead(existed ? 204 : 404);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  const [s3Port, webdavPort] = await Promise.all([
    listenOnLocalhost(s3Server),
    listenOnLocalhost(webdavServer)
  ]);

  return {
    s3Endpoint: `http://127.0.0.1:${s3Port}`,
    s3AccessKey,
    s3SecretKey,
    s3Objects,
    s3Requests,
    webdavEndpoint: `http://127.0.0.1:${webdavPort}`,
    webdavUsername,
    webdavPassword,
    webdavObjects,
    webdavRequests,
    close: async () => {
      await Promise.all([closeServer(s3Server), closeServer(webdavServer)]);
    }
  };
}
