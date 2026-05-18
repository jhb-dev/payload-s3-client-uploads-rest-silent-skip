// Variant repro: client POSTs `file` as a JSON metadata string referencing
// a filename that DOES exist in S3 (because the client uploaded it via the
// signed-URL flow, or because some leftover object exists). The metadata
// path triggers addDataAndFileToRequest.js:52-95 — staticHandler fetches
// the (pre-existing) object, req.file gets the buffer + clientUploadContext,
// and afterChange.js then filters that file out (clientUploadContext set),
// so the server never re-uploads.
//
// Crucial: `size` in the metadata is what ends up as doc.filesize, even if
// the actual S3 object is a different size. That matches the reported
// "filesize: 5000 but real file is 5592 bytes" symptom.

const BASE = process.env.BASE_URL || 'http://localhost:3000'

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

async function postMetadataOnly(apiKey) {
  // The S3 object already exists (pre-populated as `preexisting.png`, 13 bytes).
  // We lie about its size — claim 5000 bytes — to mimic the symptom.
  // Use a non-image mime type so sharp doesn't run on the (fake) S3 content
  // we fetch back. The bug is about the upload step being skipped — sharp
  // processing is incidental and would just fail on the placeholder bytes.
  const fileMetadata = {
    clientUploadContext: { uploaded: true },
    collectionSlug: 'media',
    filename: 'preexisting.bin',
    mimeType: 'application/octet-stream',
    size: 5000,
  }

  const fd = new FormData()
  fd.append('file', JSON.stringify(fileMetadata))
  fd.append('_payload', JSON.stringify({ alt: 'metadata-only, file already in S3' }))

  const res = await fetch(`${BASE}/api/media`, {
    method: 'POST',
    headers: { Authorization: `users API-Key ${apiKey}` },
    body: fd,
  })
  const json = await res.json().catch(() => null)
  log(`POST /api/media -> ${res.status}`, json)
  return json?.doc ?? json
}

const apiKey = await ensureAdminWithApiKey()
const doc = await postMetadataOnly(apiKey)
console.log('\n--- Summary ---')
console.log('Doc ID:       ', doc?.id)
console.log('Doc filename: ', doc?.filename)
console.log('Doc filesize: ', doc?.filesize, '(metadata said 5000; actual S3 object is 13 bytes)')
console.log('Doc url:      ', doc?.url)
