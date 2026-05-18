# storage-s3 `clientUploads: true` — POST `/api/<slug>` with metadata-shaped `file` field silently creates doc, no upload verified

## Description of the issue

When `s3Storage({ clientUploads: true })` is enabled on an upload collection, a multipart `POST /api/<slug>` whose `file` form-field is a **JSON string** (the shape the admin UI / signed-URL clients use to register a "I already uploaded this" payload) is accepted with a 2xx and a created document, even when:

- the claimed S3 object does not exist in the bucket, or
- the claimed `size` in the metadata does not match the real S3 object.

Payload stores the client-supplied `size`, `filename`, and `mimeType` verbatim on the new doc and never invokes `adapter.handleUpload`. There is no validation that an upload actually occurred or that the metadata matches reality.

This violates the standard REST upload contract for upload-enabled collections (doc and file land together or you get an error) and is the underlying cause of symptoms like:

- A CLI / server-to-server client posts a multipart request and gets back a 201 with `filesize: 5000` for a 5592-byte source file. The bucket has no object.
- `curl <public-url>` against the resulting doc returns 403 / NoSuchKey from S3.
- No server-side error or warning is logged.

### Bug chain

1. `addDataAndFileToRequest.js:52-95` — when `fields.file` is a string (the metadata-only shape used by the signed-URL flow), it's parsed for `{ clientUploadContext, collectionSlug, filename, mimeType, size }`, then the collection's upload-handler chain is invoked with `clientUploadContext` in `params`.
2. For `disablePayloadAccessControl: true` + `clientUploads`, that handler is `adapter.staticHandler` (see `plugin-cloud-storage/src/plugin.ts` — handler pushed at the `else if (adapter.clientUploads)` branch). `staticHandler` returns *whatever* `getFile` returns, including a 404 `Response` if the object isn't in S3.
3. Back in `addDataAndFileToRequest.js:84-95`, **any truthy `Response`** (including a 404 with empty body) is treated as success, and `req.file` is constructed from that response with `clientUploadContext` set from the original JSON.
4. `generateFileData.js:173` stores `fileData.filesize = file.size` — i.e. whatever the client put in the JSON metadata, not what's actually in S3.
5. `plugin-cloud-storage/src/hooks/afterChange.ts:35` filters out files whose `clientUploadContext` is truthy:

   ```ts
   const uploadResults = await Promise.all(
     files.filter((file) => !file.clientUploadContext).map((file) =>
       adapter.handleUpload({ ... }),
     ),
   )
   ```

   So no `adapter.handleUpload` runs. The doc creation completes. 201 is returned.

The intent visible in the design (the `!file.clientUploadContext` filter in `afterChange`) is "the client already uploaded via a signed URL, don't re-upload." The trust assumption is "the metadata is accurate and the upload succeeded." Neither is enforced — there's no `HEAD` against the bucket, no comparison of claimed vs actual size, and no failure surface when the staticHandler returns a 4xx body.

## Link to the code

- `addDataAndFileToRequest.js`: https://github.com/payloadcms/payload/blob/v3.84.1/packages/payload/src/utilities/addDataAndFileToRequest.ts
- `plugin-cloud-storage/src/hooks/afterChange.ts`: https://github.com/payloadcms/payload/blob/v3.84.1/packages/plugin-cloud-storage/src/hooks/afterChange.ts
- `storage-s3/src/getFile.ts`: https://github.com/payloadcms/payload/blob/v3.84.1/packages/storage-s3/src/getFile.ts

## Reproduction Steps

1. Clone the reproduction repository and run the development server:

   ```
   docker compose up -d         # starts mongo + minio + seeds preexisting.png (13 B)
   pnpm install
   pnpm dev
   ```

2. In another terminal, run the reproduction script:

   ```
   node scripts/reproduce.mjs
   ```

   It registers an admin user, mints an API key, then POSTs to `/api/media` with `file` as a JSON metadata string (no Blob), claiming `size: 5000` and `filename: "preexisting.bin"` (which exists in the bucket as 24 bytes).

3. **Expected**: the request fails — either Payload re-uploads server-side, or it returns an error saying the endpoint requires a real upload, or it validates the claimed size against S3.

4. **Actual** — `POST /api/media → 201`:

   ```json
   {
     "doc": {
       "url": "http://127.0.0.1:9100/payload-repro-bucket/preexisting.bin",
       "filename": "preexisting.bin",
       "mimeType": "application/octet-stream",
       "filesize": 5000,
       "id": "..."
     },
     "message": "Media successfully created."
   }
   ```

   The bucket still holds the original 24-byte `preexisting.bin` — `mc ls local/payload-repro-bucket` confirms no new write. The doc's stored `filesize` is the metadata claim, not reality.

   If you re-run the script after deleting the bucket object (`mc rm local/payload-repro-bucket/preexisting.bin`), the staticHandler returns a 404 Response — but the POST still returns 201 with the same metadata-derived doc. No object exists, the doc claims one does, no error.

## Suggested Fix

The path in `addDataAndFileToRequest.js:52-95` should either:

1. Reject responses with non-2xx status from the upload handler (currently any truthy `Response` is accepted).
2. Verify the S3 object exists and matches the claimed `size` (HEAD against bucket) before completing doc creation.
3. At minimum, refuse the signed-URL metadata shape on the `POST /api/<slug>` endpoint and require a dedicated endpoint, so the contract for `POST /api/<slug>` stays "doc and file land together."

Concretely, in `addDataAndFileToRequest.js`:

```ts
// current
if (!response) {
  if (error) payload.logger.error(error)
  throw new APIError('Expected response from the upload handler.')
}

// suggested
if (!response || !response.ok) {
  if (error) payload.logger.error(error)
  throw new APIError(
    `Client-uploaded file metadata references a missing object (${filename}).`,
    400,
  )
}
```

That alone closes the silent-2xx-no-object case; size-validation can be a follow-up.

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
  @payloadcms/translations: 3.84.1
  @payloadcms/ui/shared: 3.84.1
  react: 19.2.6
  react-dom: 19.2.6
```
