# Image Generation Control Plane

OmniRoute applies a dedicated, fail-closed control plane to:

- `POST /v1/images/generations`
- `POST /v1/providers/{provider}/images/generations`
- `POST /v1/images/edits`

Each caller must use a managed OmniRoute API key. The key identifies one person and owns that person's image policy, quota, concurrency, and audit history.

## Default policy

| Control                        | Default                               |
| ------------------------------ | ------------------------------------- |
| Image generation               | Enabled                               |
| Images per request             | `1` (not configurable)                |
| Rolling minute limit           | `2` accepted operations               |
| Rolling 24-hour limit          | `10` accepted operations              |
| Concurrent operations per key  | `1`                                   |
| Concurrent operations globally | `8`                                   |
| High/HD/auto quality           | Disabled                              |
| Default quality                | `medium`                              |
| Default size                   | `1024x1024`                           |
| Allowed sizes                  | `1024x1024`, `1536x1024`, `1024x1536` |
| Provider timeout               | Maximum 180 seconds                   |
| Image edit file                | Maximum 20 MiB                        |
| Audit retention                | 90 days                               |

Set the optional global concurrency override with:

```env
IMAGE_GENERATION_GLOBAL_MAX_CONCURRENT=8
```

Keep `API_KEY_SECRET` stable across restarts. OmniRoute uses it to derive a non-PII, non-reversible end-user identifier. For OpenAI's direct Images API it is sent in the documented `user` field. The public Responses API documents `safety_identifier`, but ChatGPT's private Codex Responses endpoint currently rejects that parameter, so the Codex adapter intentionally omits it.

## Per-person configuration

1. Open **Dashboard → API Key Manager**.
2. Open the person's key actions and choose **Edit permissions**.
3. In **Image generation policy**, configure:
   - enabled/disabled;
   - requests per minute;
   - requests per rolling 24 hours;
   - concurrent requests;
   - high-quality permission;
   - allowed sizes.
4. Save permissions.

Existing `allowedModels` and `allowedConnections` restrictions also apply to image requests, including Codex account rotation and provider-specific image routes. A value of `0` removes that minute or 24-hour limit (unlimited); it does **not** block requests. Keep positive limits for normal user keys. Per-key concurrency remains at least `1` while image generation is enabled. High-quality generation should remain disabled unless the user has a documented need and budget.

## Request tracing

Every admitted operation receives a UUID request ID. OmniRoute returns it in:

```http
x-request-id: <uuid>
access-control-expose-headers: x-request-id
```

OmniRoute reuses the trusted request ID injected by the authorization pipeline, sends the same value as `X-Client-Request-Id` to supported upstreams, and records the upstream `x-request-id` response header. Response, upstream request, and audit row therefore share one correlation ID. Use that ID to join client reports to `image_generation_events`.

The audit row contains:

- API key ID and key-name snapshot;
- operation, provider, model, and selected connection ID;
- requested/generated image counts;
- size, quality, and output format;
- status, HTTP status, stable error code, and duration;
- internal and upstream request IDs;
- prompt SHA-256 and prompt length.

It never contains the raw API key, raw prompt, credentials, or image bytes. Image handler call logs also reduce request payloads to bounded metadata and prompt fingerprint/length. Raw upstream error bodies are not written to image logs.

## Provider compatibility basis

Implementation is checked against OpenAI's current official references:

- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation): direct Images API vs. Responses API image tool, `gpt-image-2`, output options, editing, limits, and retry guidance.
- [Create image API reference](https://developers.openai.com/api/reference/resources/images/methods/generate): request fields and default base64 response behavior for GPT Image models.
- [Create Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create): public Responses API `safety_identifier` and hosted tool request contract. The private ChatGPT Codex endpoint is runtime-tested separately because its accepted fields differ.

OmniRoute's Codex adapter defaults to `b64_json`, matching GPT Image behavior, and creates a data URL only when the caller explicitly sets `response_format: "url"`. `/v1/images/edits` is currently executable only for `chatgpt-web` models; other providers return an explicit `400` rather than silently ignoring uploaded image data.

## Safe audit queries

Run these against the OmniRoute SQLite database through an approved read-only operational session. Do not export the database or copy credential tables.

```sql
-- Recent image operations with exact managed-key attribution.
SELECT request_id,
       api_key_id,
       api_key_name,
       operation,
       provider,
       model,
       connection_id,
       status,
       http_status,
       error_code,
       generated_count,
       duration_ms,
       upstream_request_id,
       created_at
FROM image_generation_events
ORDER BY created_at DESC
LIMIT 100;

-- Usage by person during the last rolling 24 hours.
SELECT api_key_id,
       api_key_name,
       COUNT(*) AS accepted_operations,
       SUM(generated_count) AS generated_images
FROM image_generation_events
WHERE status != 'rejected'
  AND created_at >= datetime('now', '-24 hours')
GROUP BY api_key_id, api_key_name
ORDER BY accepted_operations DESC;

-- Current concurrency leases.
SELECT request_id, api_key_id, api_key_name, provider, model, created_at
FROM image_generation_events
WHERE status = 'running'
ORDER BY created_at;
```

## Rejection behavior

| Status | Condition                                                                  |
| ------ | -------------------------------------------------------------------------- |
| `400`  | Invalid JSON, unknown field, unsupported option, or missing required input |
| `401`  | Missing or invalid managed API key                                         |
| `403`  | Key lifecycle/model restriction or image policy denial                     |
| `413`  | Oversized multipart edit request or image file                             |
| `429`  | Minute/day quota or per-key/global concurrency denial                      |
| `503`  | Admission/audit persistence unavailable; upstream work is not started      |

Quota and concurrency denials include `Retry-After: 60`. Provider failures complete the audit event and release the concurrency lease in a `finally` path. If the process terminates, the next admission expires running leases older than 180 seconds.

## Production request example

Use the HTTPS hostname configured in Caddy. Do not call the raw server IP when the certificate requires hostname-based SNI.

```bash
export OMNIROUTE_BASE_URL="https://<OMNIROUTE_DOMAIN>"
export OMNIROUTE_API_KEY="<MANAGED_KEY_FOR_ONE_PERSON>"

curl --fail-with-body "$OMNIROUTE_BASE_URL/v1/images/generations" \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-image-2",
    "prompt": "A clean product illustration on a neutral background",
    "n": 1,
    "size": "1024x1024",
    "quality": "medium",
    "output_format": "png",
    "timeout_ms": 180000
  }'
```

Do not place a real key directly in shell history, screenshots, tickets, or committed files. Prefer an environment variable loaded from the deployment's restricted secret store.

## Migration and rollout

Migrations are additive and run automatically:

- `068_api_key_image_policy.sql` adds conservative policy columns to `api_keys`.
- `069_image_generation_events.sql` creates the audit/admission table and indexes.

Recommended rollout:

1. Back up the SQLite database using the normal OmniRoute backup workflow.
2. Deploy the code and allow the migration runner to apply migrations 068 and 069.
3. Confirm the application reports both migrations as applied.
4. Verify one test key with a low/medium request.
5. Confirm its `x-request-id` maps to a succeeded audit row with the expected key ID/name and connection ID.
6. Confirm an anonymous request receives `401` and a second concurrent request for the same key receives `429`.
7. Review per-person policies in Key Manager before onboarding the full user group.

The schema rollback is intentionally not automatic because SQLite column removal requires table rebuilding and would discard audit data. To roll back application behavior, restore the pre-migration database backup together with the previous application version during a maintenance window.

## Credential hygiene

If an administrator password or provider credential was pasted into chat, terminal history, or a ticket during setup, rotate it. Use SSH keys for server administration and keep provider credentials in OmniRoute's protected credential storage.
