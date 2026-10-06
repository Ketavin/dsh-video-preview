/**
 * dsh-video-preview — host half.
 *
 * Registers a single prefix route `/video/*` that serves video files from the
 * session working directory with HTTP Range (206 Partial Content) support, so
 * the sidebar's inline `<video>` element can play and seek properly.
 *
 * Why a dedicated route instead of the built-in `/sidebar/file` media route?
 * The built-in media route reads the whole file into memory and replies with a
 * plain `200` (no `Accept-Ranges`), and it is capped by the 20MB `mediaLimit`
 * — fine for images/PDFs, wrong for video: without 206 responses the browser
 * disables scrubbing, and files over the cap are rejected outright. This route
 * streams from an opened file handle and honours single byte/suffix ranges.
 * If-Range conservatively returns the whole representation without a validator.
 *
 * Security posture mirrors better-sidebar's own routes:
 *  - same Host-header trust fence as the `/api` gateway (loopback or the web
 *    runtime's `trustedHosts`; cross-site browser markers refused);
 *  - the resolved path must sit under the session's authoritative working
 *    directory, including canonical link resolution. This does not sandbox a
 *    hostile local process that can concurrently replace filesystem entries.
 */
import { open, realpath } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'

/** Plugin identity for cordis.yml rows / client-modules keying. */
export const name = 'dsh-video-preview'

/** Services required before mounting: route registration + session cwd + the web runtime's trusted hosts. */
export const inject = ['webServer', 'sessions', 'webRuntime', 'sessionPersistence']

/** Content types for the video route, by extension. */
const VIDEO_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.m2ts': 'video/mp2t',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.3gp': 'video/3gpp',
  '.3g2': 'video/3gpp2',
}

// ── browser-trust fence (same semantics as @deepseek-ai/dsh-client-connection's
//    /api gateway; inlined so the plugin carries no internal dependency) ──────

function header(headers, name_) {
  const value = headers[name_]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

function isTrustedApiRequest(request, trustedHosts) {
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

// ── path helpers (same semantics as better-sidebar's src/fs-tree.ts) ────────

function requireAbsolute(path) {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new SidebarError('fs-error', `"${path}" is not an absolute path`, 400)
  }
  if (process.platform === 'win32' && path.slice(2).includes(':')) {
    throw new SidebarError('fs-error', 'alternate file streams are not supported', 400)
  }
  return resolve(path)
}

function isWithin(base, target) {
  const norm = (value) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const b = norm(base)
  const t = norm(target)
  if (process.platform === 'win32') {
    const lb = b.toLowerCase()
    const lt = t.toLowerCase()
    return lt === lb || lt.startsWith(`${lb}/`)
  }
  return t === b || t.startsWith(`${b}/`)
}

/** Local error type mirroring better-sidebar's SidebarError wire shape. */
class SidebarError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

/** Resolve only Host-owned session data; client cwd never grants file access. */
async function sessionCwdOf(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  const headerCwd = session?.header?.cwd
  if (headerCwd !== undefined && headerCwd !== '') return headerCwd
  try {
    const inspected = await ctx.sessionPersistence.inspect(sessionId)
    if (inspected.meta.cwd) return requireAbsolute(inspected.meta.cwd)
  } catch (error) {
    // Unknown/corrupt sessions cannot be replaced by the browser's cwd.
    throw new SidebarError('session-unavailable', 'session working directory is unavailable', 404)
  }
  throw new SidebarError('session-unavailable', 'session working directory is unavailable', 404)
}

function writeError(res, error) {
  const status = error instanceof SidebarError ? error.status : error?.code === 'ENOENT' ? 404 : 500
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = Buffer.from(JSON.stringify({ ok: false, error: {
    code: error instanceof SidebarError ? error.code : 'file-unavailable',
    message: error instanceof SidebarError ? error.message : 'video file is unavailable',
  } }))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) })
  res.end(body)
}

// ── Range handling ───────────────────────────────────────────────────────────

/**
 * Parse a single `Range: bytes=...` header against a known size.
 * Returns `{ start, end }` (inclusive), `null` when no range is present, or
 * `{ unsatisfiable: true }` for invalid/unsatisfiable byte ranges. Multi-range
 * and unknown units are deliberately ignored (full 200), not partly guessed.
 */
function parseRange(raw, size) {
  if (raw === undefined) return null
  const m = /^bytes=(.+)$/i.exec(raw.trim())
  if (!m) return null
  if (m[1].includes(',')) return null
  const spec = /^(\d*)-(\d*)$/.exec(m[1].trim())
  if (!spec || (spec[1] === '' && spec[2] === '')) return { unsatisfiable: true }
  if (spec[1] === '') {
    // suffix range: last N bytes
    const suffix = Number(spec[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true }
    if (suffix >= size) return { start: 0, end: size - 1 }
    return { start: size - suffix, end: size - 1 }
  }
  const start = Number(spec[1])
  const end = spec[2] === '' ? size - 1 : Number(spec[2])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return { unsatisfiable: true }
  if (start >= size) return { unsatisfiable: true }
  return { start, end: Math.min(end, size - 1) }
}

/** Render one response for a range or full request. */
async function serveFile(req, res, file, path, size, type, download) {
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    ...(download ? { 'content-disposition': `attachment; filename="video${extname(path)}"; filename*=UTF-8''${encodeURIComponent(basename(path)).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}` } : {}),
  }

  // HEAD has no range semantics. Without a proven strong file validator,
  // If-Range conservatively selects the full representation (RFC 9110 §13.1.5).
  const range = req.method === 'GET' && header(req.headers, 'if-range') === undefined
    ? parseRange(header(req.headers, 'range'), size) : null
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` })
    res.end()
    return
  }

  if (range !== null) {
    const { start, end } = range
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    })
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await pipeline(file.createReadStream({ start, end }), res)
    return
  }

  res.writeHead(200, { ...headers, 'content-length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await pipeline(file.createReadStream(), res)
}

// ── plugin body ──────────────────────────────────────────────────────────────

export function apply(ctx) {
  const fence = (req) => isTrustedApiRequest(req, ctx.webRuntime.trustedHosts)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/video',
    handler: async (req, res) => {
      if (!fence(req)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const sessionId = url.searchParams.get('sessionId')
        const raw = url.searchParams.get('path')
        if (!sessionId || sessionId.length > 256 || sessionId.includes('\0') || !raw) {
          throw new SidebarError('bad-request', 'sessionId and path are required')
        }
        const cwd = requireAbsolute(await sessionCwdOf(ctx, sessionId))
        const path = requireAbsolute(raw)
        if (!isWithin(cwd, path)) {
          throw new SidebarError('fs-error', 'video path outside the session working directory', 403)
        }
        const type = VIDEO_TYPES[extname(path).toLowerCase()]
        if (!type) throw new SidebarError('unsupported-type', 'not a supported video filename', 415)
        const [root, canonical] = await Promise.all([realpath(cwd), realpath(path)])
        if (!isWithin(root, canonical)) throw new SidebarError('fs-error', 'video path outside the session working directory', 403)
        const file = await open(canonical, 'r')
        try {
          // Stream this opened handle, not a second pathname lookup. Recheck
          // canonical containment after opening to catch ordinary link changes.
          if (!isWithin(root, await realpath(canonical))) throw new SidebarError('fs-error', 'video path changed', 403)
          const info = await file.stat()
          if (!info.isFile() || info.size === 0) throw new SidebarError('fs-error', 'empty or non-file video', 400)
          await serveFile(req, res, file, path, info.size, type, url.searchParams.get('download') === '1')
        } finally {
          await file.close()
        }
      } catch (error) {
        writeError(res, error)
      }
    },
  }), 'dsh-video-preview: /video range route')
}
