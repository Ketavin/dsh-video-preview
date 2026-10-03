import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdir, mkdtemp, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { apply } from '../index.js'

const parent = await mkdtemp(join(tmpdir(), 'video-boundaries-'))
const root = join(parent, 'workspace')
const outside = join(parent, 'outside')
await mkdir(root)
await mkdir(outside)
const file = join(root, '演示 100%.mp4')
const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251))
await writeFile(file, bytes)
await writeFile(join(outside, 'outside.mp4'), bytes)
await writeFile(join(root, 'note.txt'), 'private non-media file')
await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
const big = join(root, 'large.webm')
await writeFile(big, Buffer.alloc(24 * 1024 * 1024, 7))
let handler
const sessions = new Map([['live', { header: { cwd: root } }], ['other', { header: { cwd: outside } }]])
let coldReads = 0
const ctx = {
  sessions: { get: id => sessions.get(id) },
  sessionPersistence: { inspect: async id => {
    coldReads++
    if (id !== 'cold') throw new Error('unknown session')
    return { meta: { cwd: root }, events: [] }
  } },
  webRuntime: { trustedHosts: [] },
  webServer: { register: entry => { handler = entry.handler; return () => {} } },
  effect: fn => fn(),
}
apply(ctx)
const server = createServer((req, res) => { void handler(req, res) })
let base
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  assert(resolve(parent).startsWith(resolve(tmpdir()) + sep))
  await rm(parent, { recursive: true, force: true })
})
const url = (sessionId = 'live', path = file, extra = {}) => base + '/video?' + new URLSearchParams({ sessionId, path, ...extra })

test('cold sessions resolve Host persistence; unknown and other session cwd cannot be forged', async () => {
  assert.equal((await fetch(url('cold', file, { cwd: outside }))).status, 200)
  assert.equal(coldReads, 1)
  assert.equal((await fetch(url('unknown', file, { cwd: root }))).status, 404)
  assert.equal((await fetch(url('other', file, { cwd: root }))).status, 403)
  assert.equal((await fetch(url('', file, { cwd: root }))).status, 400)
})
test('canonical containment blocks an escaping junction while preserving in-root video', async () => {
  assert.equal((await fetch(url('live', join(root, 'escape', 'outside.mp4')))).status, 403)
  assert.equal((await fetch(url('live', join(root, '..', 'outside', 'outside.mp4')))).status, 403)
  assert.equal((await fetch(url('live', join(root, 'note.txt'), { download: '1' }))).status, 415)
  assert.equal((await fetch(url('live', join(root, 'missing.mp4')))).status, 404)
  if (process.platform === 'win32') {
    assert.equal((await fetch(url('live', file.toUpperCase()))).status, 200)
    assert.equal((await fetch(url('live', file + ':hidden.mp4'))).status, 400)
  }
})
test('invalid, reversed, noninteger and unsafe ranges are 416', async () => {
  for (const range of ['bytes=20-10', 'bytes=-0', 'bytes=-1.5', 'bytes=1e2-', 'bytes=x-y', 'bytes=-', 'bytes=9007199254740992-', 'bytes=4096-']) {
    const res = await fetch(url(), { headers: { range } })
    assert.equal(res.status, 416, range)
    assert.equal(res.headers.get('content-range'), 'bytes */4096')
    assert.equal((await res.arrayBuffer()).byteLength, 0)
  }
})
test('multi-range, unknown unit and If-Range use deliberate complete responses', async () => {
  for (const headers of [{ range: 'bytes=0-1,20-30' }, { range: 'items=1-2' }, { range: 'bytes=0-9', 'if-range': '"old"' }, { range: 'bytes=0-9', 'if-range': new Date().toUTCString() }]) {
    const res = await fetch(url(), { headers })
    assert.equal(res.status, 200)
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes)
  }
})
test('HEAD ignores ranges, suffix clamps, and downloads stream beyond 20 MiB', async () => {
  const head = await fetch(url(), { method: 'HEAD', headers: { range: 'bytes=9-19' } })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-length'), '4096')
  assert.equal((await head.arrayBuffer()).byteLength, 0)
  const suffix = await fetch(url(), { headers: { range: 'bytes=-9000' } })
  assert.equal(suffix.status, 206)
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes)
  const large = await fetch(url('live', big, { download: '1' }))
  assert.equal(large.status, 200)
  assert.match(large.headers.get('content-disposition'), /^attachment;/)
  let count = 0
  for await (const chunk of large.body) count += chunk.byteLength
  assert.equal(count, 24 * 1024 * 1024)
  const named = await fetch(url('live', file, { download: '1' }), { method: 'HEAD' })
  assert.match(named.headers.get('content-disposition'), /filename\*=UTF-8''%E6/)
})
test('forged Host or cross-origin headers are rejected before file access', async () => {
  for (const headers of [{ host: 'evil.example' }, { origin: 'null' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(url(), { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
  }
})
test('cancelled large response closes its stream and later reads still succeed', async () => {
  const response = await fetch(url('live', big))
  await response.body.cancel()
  const range = await fetch(url(), { headers: { range: 'bytes=0-7' } })
  assert.equal(range.status, 206)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8))
})
