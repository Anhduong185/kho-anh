import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export interface TestS3ServerHandle {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  requests: Array<{ method: string; url: string }>;
  hasObject(key: string): boolean;
  getObjectBytes(key: string): Buffer | null;
  corruptObject(key: string, bytes: Uint8Array): void;
  deleteObject(key: string): void;
  close(): Promise<void>;
}

export async function startTestS3Server(opts?: {
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
  bucket?: string;
}): Promise<TestS3ServerHandle> {
  const accessKeyId = opts?.accessKeyId ?? 'TEST_S3_ACCESS_KEY';
  const secretAccessKey = opts?.secretAccessKey ?? 'TEST_S3_SECRET_KEY_SUPER_SECRET';
  const region = opts?.region ?? 'us-east-1';
  const bucket = opts?.bucket ?? 'test-s3-bucket';

  const objects = new Map<string, { data: Buffer; etag: string; contentType: string; sha256Meta?: string }>();
  const multiparts = new Map<string, { key: string; contentType: string; parts: Map<number, { data: Buffer; etag: string }> }>();
  const requests: Array<{ method: string; url: string }> = [];

  const server = http.createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    requests.push({ method, url: rawUrl });

    const body = await readBody(req);
    const parsedUrl = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);

    // Verify AWS SigV4 Authorization header cryptographically
    const authHeader = req.headers.authorization ?? '';
    const authMatch = authHeader.match(
      /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([a-f0-9]{64})$/
    );
    if (!authMatch) {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>AccessDenied</Code><Message>Missing or malformed SigV4 Authorization</Message></Error>');
      return;
    }

    const [, reqKeyId, dateStamp, reqRegion, signedHeadersRaw, providedSig] = authMatch;
    if (reqKeyId !== accessKeyId || reqRegion !== region) {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>InvalidAccessKeyId</Code><Message>Credential mismatch</Message></Error>');
      return;
    }

    const amzDate = String(req.headers['x-amz-date'] ?? '');
    const payloadSha = String(req.headers['x-amz-content-sha256'] ?? '');
    if (!amzDate || !payloadSha) {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>AccessDenied</Code><Message>Missing x-amz-date or x-amz-content-sha256</Message></Error>');
      return;
    }
    if (payloadSha !== 'UNSIGNED-PAYLOAD') {
      const actualPayloadHash = crypto.createHash('sha256').update(body).digest('hex');
      if (actualPayloadHash !== payloadSha) {
        res.writeHead(400, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
        return;
      }
    }

    const canonicalUri = parsedUrl.pathname
      .split('/')
      .map((s) => encodeRfc3986(decodeURIComponent(s)))
      .join('/');

    const queryPairs: Array<[string, string]> = [];
    for (const [k, v] of parsedUrl.searchParams.entries()) {
      queryPairs.push([encodeRfc3986(k), encodeRfc3986(v)]);
    }
    queryPairs.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

    const signedHeaderNames = signedHeadersRaw!.split(';').map((s) => s.trim().toLowerCase());
    const canonicalHeaders = signedHeaderNames
      .map((h) => `${h}:${String(req.headers[h] ?? '').trim()}\n`)
      .join('');

    const canonicalRequest = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaderNames.join(';'),
      payloadSha
    ].join('\n');

    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex')
    ].join('\n');

    const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp!);
    const kRegion = hmacSha256(kDate, region);
    const kService = hmacSha256(kRegion, 's3');
    const kSigning = hmacSha256(kService, 'aws4_request');
    const expectedSig = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    if (
      expectedSig.length !== providedSig!.length ||
      !crypto.timingSafeEqual(Buffer.from(expectedSig, 'hex'), Buffer.from(providedSig!, 'hex'))
    ) {
      res.writeHead(403, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }

    // Extract bucket & key (path-style: /<bucket>/<key...>)
    const pathParts = parsedUrl.pathname.replace(/^\/+/, '').split('/');
    const reqBucket = decodeURIComponent(pathParts[0] ?? '');
    if (reqBucket !== bucket) {
      res.writeHead(404, { 'Content-Type': 'application/xml' });
      res.end('<Error><Code>NoSuchBucket</Code></Error>');
      return;
    }
    const key = pathParts.slice(1).map((s) => decodeURIComponent(s)).join('/');

    // Bucket HEAD
    if (!key && method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Multipart initiate: POST /bucket/key?uploads
    if (method === 'POST' && parsedUrl.searchParams.has('uploads')) {
      const uploadId = crypto.randomUUID();
      multiparts.set(uploadId, {
        key,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        parts: new Map()
      });
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(
        `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`
      );
      return;
    }

    // Multipart upload part: PUT /bucket/key?partNumber=X&uploadId=Y
    if (method === 'PUT' && parsedUrl.searchParams.has('partNumber') && parsedUrl.searchParams.has('uploadId')) {
      const uploadId = parsedUrl.searchParams.get('uploadId')!;
      const partNumber = Number(parsedUrl.searchParams.get('partNumber')!);
      const sess = multiparts.get(uploadId);
      if (!sess || sess.key !== key) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      const etag = crypto.createHash('md5').update(body).digest('hex');
      sess.parts.set(partNumber, { data: body, etag });
      res.writeHead(200, { ETag: `"${etag}"` });
      res.end();
      return;
    }

    // Multipart complete: POST /bucket/key?uploadId=Y
    if (method === 'POST' && parsedUrl.searchParams.has('uploadId')) {
      const uploadId = parsedUrl.searchParams.get('uploadId')!;
      const sess = multiparts.get(uploadId);
      if (!sess || sess.key !== key) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      const xmlText = body.toString('utf8');
      const partMatches = [...xmlText.matchAll(/<PartNumber>(\d+)<\/PartNumber>\s*<ETag>"?([^"<]+)"?<\/ETag>/g)];
      const assembled: Buffer[] = [];
      for (const m of partMatches) {
        const pn = Number(m[1]!);
        const et = m[2]!;
        const storedPart = sess.parts.get(pn);
        if (!storedPart || storedPart.etag !== et) {
          res.writeHead(400, { 'Content-Type': 'application/xml' });
          res.end('<Error><Code>InvalidPart</Code></Error>');
          return;
        }
        assembled.push(storedPart.data);
      }
      const full = Buffer.concat(assembled);
      const etag = crypto.createHash('md5').update(full).digest('hex');
      objects.set(key, { data: full, etag, contentType: sess.contentType });
      multiparts.delete(uploadId);
      res.writeHead(200, { 'Content-Type': 'application/xml' });
      res.end(`<CompleteMultipartUploadResult><ETag>"${etag}"</ETag></CompleteMultipartUploadResult>`);
      return;
    }

    // Multipart abort: DELETE /bucket/key?uploadId=Y
    if (method === 'DELETE' && parsedUrl.searchParams.has('uploadId')) {
      multiparts.delete(parsedUrl.searchParams.get('uploadId')!);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'PUT') {
      const etag = crypto.createHash('md5').update(body).digest('hex');
      objects.set(key, {
        data: body,
        etag,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
        sha256Meta: req.headers['x-amz-meta-sha256'] ? String(req.headers['x-amz-meta-sha256']) : undefined
      });
      res.writeHead(200, { ETag: `"${etag}"` });
      res.end();
      return;
    }

    if (method === 'HEAD') {
      const obj = objects.get(key);
      if (!obj) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(obj.data.length),
        'Content-Type': obj.contentType,
        ETag: `"${obj.etag}"`,
        ...(obj.sha256Meta ? { 'x-amz-meta-sha256': obj.sha256Meta } : {})
      });
      res.end();
      return;
    }

    if (method === 'GET') {
      const obj = objects.get(key);
      if (!obj) {
        res.writeHead(404, { 'Content-Type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      const rangeHeader = req.headers.range;
      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const [sStr, eStr] = rangeHeader.slice(6).split('-');
        const start = Number(sStr);
        const end = eStr ? Math.min(Number(eStr), obj.data.length - 1) : obj.data.length - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= obj.data.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${obj.data.length}` });
          res.end();
          return;
        }
        const slice = obj.data.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': obj.contentType,
          'Content-Range': `bytes ${start}-${end}/${obj.data.length}`,
          'Content-Length': String(slice.length),
          ETag: `"${obj.etag}"`
        });
        res.end(slice);
        return;
      }

      res.writeHead(200, {
        'Content-Type': obj.contentType,
        'Content-Length': String(obj.data.length),
        ETag: `"${obj.etag}"`
      });
      res.end(obj.data);
      return;
    }

    if (method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    requests,
    hasObject: (k) => objects.has(k),
    getObjectBytes: (k) => objects.get(k)?.data ?? null,
    corruptObject: (k, bytes) => {
      const buf = Buffer.from(bytes);
      const existing = objects.get(k);
      objects.set(k, {
        data: buf,
        etag: crypto.createHash('md5').update(buf).digest('hex'),
        contentType: existing?.contentType ?? 'application/octet-stream'
      });
    },
    deleteObject: (k) => {
      objects.delete(k);
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}

export interface TestWebDavServerHandle {
  endpoint: string;
  basePath: string;
  username: string;
  password: string;
  requests: Array<{ method: string; url: string }>;
  hasObject(key: string): boolean;
  getObjectBytes(key: string): Buffer | null;
  corruptObject(key: string, bytes: Uint8Array): void;
  deleteObject(key: string): void;
  close(): Promise<void>;
}

export async function startTestWebDavServer(opts?: {
  username?: string;
  password?: string;
  basePath?: string;
}): Promise<TestWebDavServerHandle> {
  const username = opts?.username ?? 'dav_user';
  const password = opts?.password ?? 'dav_app_pass_utf8_!';
  const basePath = (opts?.basePath ?? 'vault-photos').replace(/^\/+|\/+$/g, '');
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

  const dirs = new Set<string>(['/dav']);
  const files = new Map<string, { data: Buffer; etag: string; contentType: string }>();
  const requests: Array<{ method: string; url: string }> = [];

  const server = http.createServer(async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const rawUrl = req.url ?? '/';
    requests.push({ method, url: rawUrl });

    if (req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TestWebDAV"' });
      res.end('Unauthorized');
      return;
    }

    const parsedUrl = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
    const normPath = decodeURIComponent(parsedUrl.pathname).replace(/\/+$/, '') || '/';
    const body = await readBody(req);

    if (method === 'MKCOL') {
      if (dirs.has(normPath)) {
        res.writeHead(405);
        res.end();
        return;
      }
      const parent = normPath.slice(0, normPath.lastIndexOf('/')) || '/';
      if (!dirs.has(parent)) {
        res.writeHead(409);
        res.end();
        return;
      }
      dirs.add(normPath);
      res.writeHead(201);
      res.end();
      return;
    }

    if (method === 'PROPFIND') {
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end('<multistatus xmlns="DAV:"><response><href>' + normPath + '</href></response></multistatus>');
      return;
    }

    if (method === 'PUT') {
      const parent = normPath.slice(0, normPath.lastIndexOf('/')) || '/';
      if (!dirs.has(parent)) {
        res.writeHead(409);
        res.end('Parent collection missing');
        return;
      }
      const etag = crypto.createHash('md5').update(body).digest('hex');
      files.set(normPath, {
        data: body,
        etag,
        contentType: String(req.headers['content-type'] ?? 'application/octet-stream')
      });
      res.writeHead(201, { ETag: `"${etag}"` });
      res.end();
      return;
    }

    if (method === 'HEAD') {
      const f = files.get(normPath);
      if (!f) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Length': String(f.data.length),
        'Content-Type': f.contentType,
        ETag: `"${f.etag}"`
      });
      res.end();
      return;
    }

    if (method === 'GET') {
      const f = files.get(normPath);
      if (!f) {
        res.writeHead(404);
        res.end();
        return;
      }
      const rangeHeader = req.headers.range;
      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const [sStr, eStr] = rangeHeader.slice(6).split('-');
        const start = Number(sStr);
        const end = eStr ? Math.min(Number(eStr), f.data.length - 1) : f.data.length - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || start > end || start >= f.data.length) {
          res.writeHead(416, { 'Content-Range': `bytes */${f.data.length}` });
          res.end();
          return;
        }
        const slice = f.data.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': f.contentType,
          'Content-Range': `bytes ${start}-${end}/${f.data.length}`,
          'Content-Length': String(slice.length),
          ETag: `"${f.etag}"`
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        'Content-Type': f.contentType,
        'Content-Length': String(f.data.length),
        ETag: `"${f.etag}"`
      });
      res.end(f.data);
      return;
    }

    if (method === 'DELETE') {
      files.delete(normPath);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const keyToPath = (k: string) => `/dav/${basePath}/${k.replace(/^\/+/, '')}`;

  return {
    endpoint: `http://127.0.0.1:${port}/dav`,
    basePath,
    username,
    password,
    requests,
    hasObject: (k) => files.has(keyToPath(k)),
    getObjectBytes: (k) => files.get(keyToPath(k))?.data ?? null,
    corruptObject: (k, bytes) => {
      const p = keyToPath(k);
      const buf = Buffer.from(bytes);
      files.set(p, {
        data: buf,
        etag: crypto.createHash('md5').update(buf).digest('hex'),
        contentType: 'application/octet-stream'
      });
    },
    deleteObject: (k) => {
      files.delete(keyToPath(k));
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
  };
}
