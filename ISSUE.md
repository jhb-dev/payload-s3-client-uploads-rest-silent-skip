# storage-s3 silently skips S3 upload when create request uses `?select[…]` to project out `mimeType`

## Description of the issue

When a `POST /api/<upload-slug>?select[…]=true` request creates a doc on a collection configured with `@payloadcms/storage-s3` (or any `cloud-storage` adapter), and the `select` query projects `mimeType` (and/or `filename`) out of the result doc, **the file is silently not uploaded to S3**:

- HTTP 201 returned
- doc persisted to Mongo with all sharp-computed metadata (filename, mimeType, filesize, sizes)
- Bucket holds **no** object at the key
- `GET <public-url>` → 403 / 404
- Server logs: nothing — no error, no warning

The same request without the `select` query writes all variants to S3 normally.

## Root cause

`@payloadcms/plugin-cloud-storage/src/utilities/getIncomingFiles.ts` reads `filename` and `mimeType` from the `data` argument (the doc passed through hooks):

```ts
if (file && data.filename && data.mimeType) {
  const mainFile = { buffer: file.data, ..., mimeType: data.mimeType }
  files = [mainFile]
  // ...build sizes
}
return files
```

When the request uses `?select[id]=true&select[filename]=true&select[filesize]=true`, the `doc` flowing through hooks is the select-projected version — `data.mimeType` is `undefined`. The condition fails, `files = []`, the `afterChange` hook in `plugin-cloud-storage` does nothing, and `adapter.handleUpload` is never called.

The file itself is on `req.file` (set by `addDataAndFileToRequest` / `processMultipart`) with the correct mime type the whole time. The hook just refuses to use it because the projected doc is missing the field.

## Link to the code

- [`getIncomingFiles.ts`](https://github.com/payloadcms/payload/blob/v3.84.1/packages/plugin-cloud-storage/src/utilities/getIncomingFiles.ts)
- [`afterChange.ts`](https://github.com/payloadcms/payload/blob/v3.84.1/packages/plugin-cloud-storage/src/hooks/afterChange.ts)

## Reproduction Steps

1. Clone the reproduction repository and run the development server:

   ```
   docker compose up -d       # starts mongo + minio + creates the bucket
   pnpm install
   pnpm dev
   ```

2. In another terminal, run the reproduction script:

   ```
   node scripts/reproduce.mjs
   ```

   The script registers an admin user, mints an API key, and uploads the same `test.webp` twice:

   - first with `?select[id]=true&select[filename]=true&select[filesize]=true` → the bug
   - then with no `select` query → the control case

3. Inspect the bucket:

   ```
   docker exec repro-minio mc ls local/payload-repro-bucket
   ```

4. **Expected**: both filenames present in the bucket (original + size variants).

5. **Actual**:

   ```
   ok-without-select-…-1024x683.webp
   ok-without-select-…-1200x630.webp
   ok-without-select-…-480x320.webp
   ok-without-select-…-768x512.webp
   ok-without-select-….webp
   ```

   Only the **control** upload (without `select`) made it to S3. The first upload — which returned 201 with a created doc — has no objects in the bucket.

   The doc with the broken upload references a filename whose binary never made it to storage. `GET` against `media.url` returns 403/404. There is no error in the server logs.

## Suggested Fix

`getIncomingFiles` should fall back to the in-memory `file` object when `data.filename` / `data.mimeType` are missing — those fields are already populated on `req.file` regardless of what the response doc projection includes:

```ts
// packages/plugin-cloud-storage/src/utilities/getIncomingFiles.ts
const effectiveFilename = data.filename ?? file?.name
const effectiveMimeType = data.mimeType ?? file?.mimetype

if (file && effectiveFilename && effectiveMimeType) {
  const mainFile = {
    buffer: file.data,
    clientUploadContext: file.clientUploadContext,
    filename: effectiveFilename,
    filesize: file.size,
    mimeType: effectiveMimeType,
    tempFilePath: file.tempFilePath,
  }
  files = [mainFile]
  // …
}
```

Verified locally with `pnpm patch @payloadcms/plugin-cloud-storage@3.84.1` against this reproduction: the main object now uploads correctly when `?select[…]` is used.

**Follow-up**: the same projection issue affects `data.sizes` — if `sizes` isn't in the select, image-size variants are still skipped. A complete fix should fall back to `req.payloadUploadSizes` for variants when `data.sizes` is missing.

## Environment Info

```
Relevant Packages:
  payload: 3.84.1
  next: 16.2.6
  @payloadcms/db-mongodb: 3.84.1
  @payloadcms/graphql: 3.84.1
  @payloadcms/next/utilities: 3.84.1
  @payloadcms/plugin-cloud-storage: 3.84.1
  @payloadcms/richtext-lexical: 3.84.1
  @payloadcms/storage-s3: 3.84.1
```
