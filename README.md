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

Incoming request bodies, including image attachments, are limited to 256 MiB.
Set `REQUEST_BODY_LIMIT_MB` in `.env` and restart to change this limit.
Oversized requests return HTTP 413 and appear in **Requests** with the reason.

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
| **Quota aware** | Interleaves requests by remaining allowance and time until each reset, refined by reliable consumption observations. |

`weighted-usage` remains accepted in saved configurations as an alias of
`max-remaining`; it is not a separate option in the interface.

Quota aware uses Factory's remaining percentages and reset dates immediately. It
compares remaining percentage per hour between accounts **within each window**,
normalizes those values into relative shares, then uses each account's most restrictive
share across the five-hour, weekly and monthly windows. Weighted fair scheduling
interleaves requests; it does not drain one account before using the next. Concurrent
requests reserve their place immediately. Unsent or explicitly rejected requests
refund that reservation; token counting is not generation work.

Consumption estimates refine each window independently, per account, usage pool,
model, coarse context-size band and reasoning setting. Only successful completions
contribute to these estimates. At least three intervals, each with eight settled
completions and a usage increase over two percentage points, are required. The
calculation allows two minutes around cohort boundaries for telemetry lag and a
two-point rounding uncertainty. These are conservative estimation allowances, not
guarantees about Factory's reporting delay. Mixed-model intervals, uncertain outcomes
and detected external consumption cannot train a model's price. Such accounts still
participate using remaining allowance and reset dates; they do not hold back other
accounts' estimates. No-change readings do not renew evidence, which expires after
seven days. A flat monthly counter does not prevent five-hour or weekly learning.

Missing or failed telemetry is labeled and gets a conservative relative share, never
an assumed full quota or imminent-reset advantage. Price corrections are damped by
confidence. Factory's rounded/delayed readings, variable response costs and concurrent
usage outside this proxy still prevent exact attribution or a guaranteed optimal
schedule. This is an adaptive allocation policy, not a per-request billing meter.

The calibration, last 64 measurements per pool and scheduling credits persist in
`data/key_pool.json` through the existing atomic writer. In-flight locks are local
to the running process and are not restored after restart; unfinished observations
are marked uncertain. Legacy per-assignment estimates are discarded during migration,
while scheduling credits are retained. Writes are batched without waiting for an
idle period, and graceful shutdown flushes pending changes. Quota aware requires
single-process mode (`CLUSTER_MODE=false`, the default); multi-worker mode is rejected
instead of silently using inconsistent reservations. An abrupt power loss can lose
the last batched statistics update.

Automatic starts remain the authority for synchronized groups. Quota aware considers
the group's next collective boundary, including exhausted weekly/monthly members
and configured working hours, and never bypasses its routing barrier. Saved membership
and exclusion changes apply on the next selection without a restart. Removing an
account from automatic starts does not exclude it from normal routing. Account
**Details** shows the last calculated share, limiting window, learning status and
calculation time; these are scheduling estimates, not promised usage percentages.

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
that pool's synchronization barrier. Accounts remain available for normal client requests.
It does not undo a window that has already started.

These controls govern this proxy only. A client using a built-in Factory model
instead of the proxy can consume its logged-in Factory account directly.

On **Accounts**, the action follows the selected **Standard / Droid Core** tab:
**Start now** starts an inactive window; **Starting…** means the request is queued
or its window is being verified; **Test** sends one short request within an active
window. Tests are disabled for accounts managed by that pool's synchronization.
Unavailable actions show the reason. Both actions use that pool's start model from
**Five-hour windows**. New configurations default to Luna for Standard and
GLM-5.3-Flash for Core; saved model choices are preserved.

A manual start leaves synchronization enabled. The scheduler records the attempt,
checks Factory's window before retrying, and waits for current group windows to end
before the next automatic cycle. Manual starts are explicit and may run outside
configured automatic working hours. A test with an unknown outcome is not replayed.

### Automatic five-hour starts

In **Five-hour windows**, select **Standard** or **Droid Core**, choose accounts
and a start model, enable **Enable automatic starts**, and save. Each pool has its
own selection, model, working hours and persistent cycle. Switching pools preserves
unsaved edits; **Save settings** saves both. An account can belong to both pools.
Automatic starts and working hours are off by default. Existing single-pool settings
and attempts migrate to their original pool; the other pool stays off.

Pools start independently unless **Start both pools together** is enabled. Joint
starts wait for both groups, then send a separate request for each account/pool.
Their working hours must overlap. Disabling either pool removes it from the barrier.
Quota aware uses the same group membership and joint scheduling horizon.

- Active windows remain usable. Selected accounts whose windows have ended wait
  until the whole included group is ready and has weekly and monthly quota.
- Removing a member or excluding an account takes effect without restarting.
  New members added during a launch join the next cycle. Changing independent/joint
  mode affects the next cycle; an in-progress cycle retains its original partners.
- Excluded accounts are omitted. Selected disabled, untested, or exhausted accounts
  can block the group. Remove them from the selection or disable synchronization
  to let other accounts work independently.
- Short start requests run in parallel with a 32-output-token cap. They consume
  quota; normal client budgets are unaffected.
- Failed checks retry with backoff. Ambiguous generation failures trigger fresh
  quota checks before retrying. Successful starts are verified without replaying
  the generation. Delayed telemetry can make an ambiguous retry redundant;
  simultaneous or exactly-once starts are not guaranteed. If a confirmed window
  expires while another participant is still pending, it is checked and started again.
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
| `data/key_pool.json` | Factory keys, account metadata, exclusions, and quota-balancing measurements/credits |
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
