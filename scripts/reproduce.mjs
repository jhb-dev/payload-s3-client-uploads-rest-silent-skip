// Reproduction: POST /api/<upload-slug> with a binary file blob and a
// `?select[…]` query that projects `mimeType` out of the result doc.
//
// Result: 201 with a created doc; bucket gets no object.
//
// Root cause: the `doc` passed through hooks is the select-projected doc.
// `@payloadcms/plugin-cloud-storage/src/utilities/getIncomingFiles.ts`
// requires both `data.filename` AND `data.mimeType` to be truthy. When
// `mimeType` is projected out, getIncomingFiles returns []; afterChange
// has nothing to upload; adapter.handleUpload is never called.

import { readFile } from 'node:fs/promises'

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const FILE_PATH = process.env.FILE_PATH || './test.webp'

const log = (label, data) =>
  console.log(`\n=== ${label} ===\n${typeof data === 'string' ? data : JSON.stringify(data, null, 2)}`)

async function ensureAdminWithApiKey() {
  await fetch(`${BASE}/api/users/first-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@example.com',
      password: 'password',
      'confirm-password': 'password',
    }),
  })
  const login = await fetch(`${BASE}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'password' }),
  })
  const { token, user } = await login.json()
  let apiKey = user?.apiKey
  if (!apiKey) {
    apiKey = crypto.randomUUID()
    await fetch(`${BASE}/api/users/${user.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` },
      body: JSON.stringify({ enableAPIKey: true, apiKey }),
    })
  }
  return apiKey
}

async function upload({ apiKey, filename, useSelect }) {
  const buffer = await readFile(FILE_PATH)
  const fd = new FormData()
  fd.append('file', new Blob([buffer], { type: 'image/webp' }), filename)

  const query = useSelect
    ? '?select[id]=true&select[filename]=true&select[filesize]=true'
    : ''
  const res = await fetch(`${BASE}/api/media${query}`, {
    method: 'POST',
    headers: { Authorization: `users API-Key ${apiKey}` },
    body: fd,
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, doc: body?.doc ?? body }
}

const apiKey = await ensureAdminWithApiKey()
const ts = Date.now()

const broken = await upload({
  apiKey,
  filename: `bug-with-select-${ts}.webp`,
  useSelect: true,
})
log(`WITH ?select[…] (broken) → ${broken.status}`, broken.doc)

const working = await upload({
  apiKey,
  filename: `ok-without-select-${ts}.webp`,
  useSelect: false,
})
log(`WITHOUT select (control) → ${working.status}`, {
  filename: working.doc?.filename,
  filesize: working.doc?.filesize,
})

console.log('\n--- Now check the bucket ---')
console.log('  Expected: only the second filename (ok-without-select-…) is present.')
console.log('  Actual:   the first (bug-with-select-…) is missing despite the 201.')
console.log('\n  Run: docker exec repro-minio mc ls local/payload-repro-bucket')
