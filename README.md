# droid2api

A local API proxy for Factory accounts, with account balancing, usage-limit
monitoring, and OpenAI and Anthropic client endpoints.

Based on [BaSui01/droid2api](https://github.com/BaSui01/droid2api), which derives
from [1e0n/droid2api](https://github.com/1e0n/droid2api).

## Features

- Account pools with balancing policies and persistent exclusions.
- Standard and Droid Core usage windows: five hours, seven days, and thirty days.
- OpenAI Responses, Anthropic Messages, and Chat Completions endpoints.
- Streaming, task connection reuse, and upstream cache-usage reporting.
- Optional synchronized starts for selected five-hour windows.
- A web admin panel for accounts, windows, requests, and settings.

## Installation

Use Node.js 24 and npm, or the included Docker image definition.

```bash
git clone https://github.com/embogomolov/droid2api.git
cd droid2api
npm ci
```

Create `.env` in the project directory. Choose separate, non-default secrets:

```env
ADMIN_ACCESS_KEY=replace-with-your-admin-secret
API_ACCESS_KEY=replace-with-your-client-secret
PORT=3000
AUTOMATIC_KEY_TESTS=false
```

For balancing, leave `FACTORY_API_KEY` unset. Keep the included `data/config.json`;
the server creates the key-pool file when needed.

```bash
npm start
```

On Windows PowerShell, use `npm.cmd` if execution policy blocks `npm.ps1`.
Open `http://localhost:3000/` and sign in with `ADMIN_ACCESS_KEY`.

### Add accounts

1. Open **Accounts → Add keys** and paste one Factory API key per line.
2. Import the keys. Importing does not send model requests.
3. Set an available, inexpensive `key_test_model` in the server configuration.
4. Use **Test** on each account you want to use. Tests consume quota and can start
   usage windows. Accounts must pass a test before routing selects them.
5. Use **Details → Name / notes** to label accounts. The displayed suffix is the
   last nine characters of the real key; admin API operations use internal IDs.

Keep **Enable automatic starts** off unless you want the proxy to start windows itself.

## Authentication

| Setting | Purpose |
| --- | --- |
| `ADMIN_ACCESS_KEY` | Panel sign-in and `/admin/*` access through `x-admin-key`. |
| `API_ACCESS_KEY` | Client access through `Authorization: Bearer ...` or `x-api-key`. Use this value in client configurations. |
| Pool account keys | Authenticate upstream requests to Factory. |
| `FACTORY_API_KEY` | Optional fixed upstream key. Overrides balancing and bypasses client-key validation in this mode. |

Without `API_ACCESS_KEY`, client requests are accepted without client authentication.
Restrict network access accordingly. Do not use a Factory account key as the shared
client secret for the balanced setup.

OAuth helpers exist in the source, but the native Responses and Messages gateway
selects pool accounts or `FACTORY_API_KEY`. Use one of those methods for these endpoints.

## Admin interface

| Page | Controls |
| --- | --- |
| **Accounts** | Import, label, test, exclude, and delete keys; inspect routing status and Factory limits. |
| **Five-hour windows** | Select accounts and a start model; inspect automatic-start readiness, checks, and attempts. |
| **Requests** | Inspect recent outcomes, accounts, duration, reported tokens, and error details. |
| **Settings** | Select balancing, view client URLs, and edit models, groups, prompt filtering, and advanced configuration. |

Standard and Droid Core have separate usage groups. Percentages and reset times
come from Factory telemetry. Unknown or stale data is labelled; local token totals
are not a substitute for remaining quota. **Refresh limits** does not send a
model-generation request.

### Balancing

Choose a policy under **Settings → Balancing → Save balancing**.

| Policy | Selection |
| --- | --- |
| **Max remaining** | Most headroom in the account's most-used active window, considering five-hour, weekly, and monthly limits. |
| **Round robin** | Rotates through eligible accounts. Equal request counts do not imply equal quota consumption. |
| **Random** | Picks an eligible account randomly. |
| **Fewest requests** | Lowest recorded request count. |
| **Weighted score / Fewest tokens / Time window** | Uses the corresponding score, token totals, or recent usage. |
| **Weighted usage / Quota aware** | Same Factory-window headroom calculation as Max remaining. |

When multi-tier groups are enabled, group priority is applied first; lower numbers
take precedence. Excluded, untested, disabled, unavailable, and synchronization-blocked
accounts cannot be selected.

Every request follows the policy, including an existing task's continuation. There
is no fixed account binding for a conversation. An account change can require sending
the full prepared context; cache hits and billing depend on the upstream.

### Disable usage or disable automatic starts?

**Disable usage** excludes an account from routing and generation tests, including
automatic starts. It remains visible for monitoring. **Enable usage** removes the
exclusion; test, status, and quota requirements still apply. Already-sent requests
can finish.

Turning off **Enable automatic starts** stops automatic start requests and releases
the synchronization barrier. Accounts remain available for normal client requests.
It does not undo a window that has already started.

These controls govern this proxy only. A client using a built-in Factory model
instead of the proxy can consume its logged-in Factory account directly.

### Automatic five-hour starts

Select accounts and an available start model in **Five-hour windows**, enable
**Enable automatic starts**, and save. Choose a Standard model for Standard windows
or a Core model for Core windows. Automatic starts and working hours are off by
default. New accounts are not added to the selection automatically.

- Active windows remain usable. Selected accounts whose windows have ended wait
  until the whole included group is ready and has weekly and monthly quota.
- Excluded accounts are omitted. Selected disabled, untested, or exhausted accounts
  can block the group. Remove them from the selection or disable synchronization
  to let other accounts work independently.
- Short start requests run in parallel with a 32-output-token cap. They consume
  quota; normal client budgets are unaffected.
- Failed checks retry with backoff. Ambiguous generation failures trigger fresh
  quota checks before retrying. Successful starts are verified without replaying
  the generation. Delayed telemetry can make an ambiguous retry redundant;
  simultaneous or exactly-once starts are not guaranteed.
- Working hours use the server timezone and limit new cycles. A cycle in progress
  can finish outside those hours.
- Attempts survive restarts. Starting the proxy with this feature enabled can start
  ready windows without any client request. A single selected account is supported.

The panel separates the window end from the next telemetry check and explains why
the group is waiting. **Checks and attempts** contains per-account details.
Synchronization cannot increase quota or reset an active Factory window.

## Models and clients

Edit models in `data/config.json` or **Settings → Models and advanced settings → Models**.
Each entry needs its upstream `id` and provider `type`: `openai`, `anthropic`, or
`common`. `/v1/models` lists configured models, not guaranteed account permissions.

Use `reasoning: "auto"` to retain client-supplied reasoning or thinking settings:

```json
{
  "id": "claude-haiku-4-5-20251001",
  "name": "Claude Haiku 4.5",
  "type": "anthropic",
  "reasoning": "auto"
}
```

Fixed `low`, `medium`, and `high` settings use the corresponding OpenAI effort, or
Anthropic `thinking.budget_tokens` from `reasoning_tokens` (defaults: 4096, 12288,
24576). `off` removes the reasoning/thinking field handled by that path. The model
must support the parameters it receives; token budgets and adaptive effort differ.

### Endpoints

| Endpoint | Format |
| --- | --- |
| `GET /v1/models` | Configured model list |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/chat/completions` | OpenAI Chat Completions, converted for the selected provider where needed |
| `POST /v1/messages/count_tokens` | Forwards Anthropic token counting; availability depends on the upstream |

Use `http://localhost:3000/v1` as the OpenAI base URL and `http://localhost:3000`
as the Anthropic base URL. Supply `API_ACCESS_KEY` as the client credential.
Generation endpoints accept `stream: true` for streaming or `false` for final JSON.

```bash
curl http://localhost:3000/v1/models \
  -H "Authorization: Bearer replace-with-your-client-secret"
```

For Claude Code, see [CLAUDE_CODE.md](CLAUDE_CODE.md). Other clients need a matching
custom-provider protocol, local base URL, client credential, and configured model ID.
The client owns its tools, hooks, history, and context management.

### Preparation, transport, and caching

The configured `system_prompt` is prepended to client instructions. Factory request
preparation uses `You are Droid, an AI software engineering agent built by Factory.`
Keep the supplied compatibility prompt when using Factory. Anthropic preparation
also rephrases specific built-in client identity/environment phrases.

Factory Responses uses an upstream WebSocket while clients connect through local
HTTP. Matching continuations can use `previous_response_id`; reconnects and account
changes send the prepared full context. Background requests use HTTP. Repeated
WebSocket transport failures enable HTTP fallback for subsequent session requests.
Anthropic Messages uses HTTP/SSE.

The proxy preserves cache identity and forwards supported cache controls without
manufacturing warm-up generations. Cache reads/writes are shown when reported.
Cache hits and equal costs across clients are not guaranteed. PNG/JPEG inputs may
be resized and recompressed. Text history is not silently trimmed or summarized;
original local files are not rewritten. Upstream payload and context limits apply.

Prompt-filter rules affect supported conversion paths. Native Responses bypasses
the keyword filter; disabling it does not disable the compatibility prompt.

## Configuration and storage

Settings are saved in `data/config.json`. Advanced objects merge with saved values;
arrays replace the whole array. Listener, environment, and transport changes can
require a restart. `PORT` overrides the configured listen port.

| Local file | Contents |
| --- | --- |
| `.env` | Credentials and environment settings |
| `data/key_pool.json` | Factory keys, account metadata, and exclusions |
| `data/config.json` | Models, endpoints, balancing, and automatic-window selection |
| `data/window_sync.json` | Persistent start attempts |
| `logs/` | Server logs |

Credential files, key pools, window journals, and logs are ignored by Git.
`data/config.json` is tracked: review changes before committing because saved
settings can include account IDs or other local values.

### Docker

With `.env` configured:

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

Compose mounts `data/` and `logs/` for persistence. It supplies
`KEY_POOL_ALGORITHM=round-robin` when absent; set the variable explicitly if needed.
See [docker-compose.yml](docker-compose.yml) and [Dockerfile](Dockerfile) for details.

## Diagnostics

**Requests → Details** shows upstream error codes and messages when available.
The panel retains up to 500 events per server process, not a durable history.
Token counts appear only when reported upstream. Treat server logs and captured
requests as private data.

- **Waiting for group:** inspect the automatic-start selection. Disable
  synchronization to let eligible accounts work independently.
- **Limit / cooldown:** check usage windows and retry/reset times.
- **401 / 403:** check client credentials, Factory permissions, the model, and
  compatibility prompt. These statuses alone do not identify a network failure.
- **413:** reduce request size through attachments or client context management;
  changing accounts does not shrink the payload.
- **`upstream_error_event`:** inspect the provider's error code and message.
- **`client_disconnected`:** the client closed the connection and the proxy cancelled
  upstream work. Check client logs for cancellation or timeout details.
- **`upstream_connection_failed`:** the upstream connection failed. An ambiguous
  request is not replayed automatically because it may already consume quota.

The native gateway can switch accounts after eligible authentication or quota
rejections. Server errors are retryable only when the transport establishes that
the request was not sent. Accepted requests and interrupted streams are not
silently replayed. The proxy does not substitute another model.

## Development checks

Run the offline suite in a temporary copy with an empty key pool:

```bash
node tests/run-network-checks.mjs
```

`tests/admin-ui.cjs` requires Playwright, starts a local static server, and mocks
admin requests. Set `DROID_UI_ROOT` to the checkout's `public` directory when running
it from another location. Live probe scripts send billable requests when enabled;
ordinary telemetry refresh does not require generation probes.

## License

MIT, as declared in [package.json](package.json).
