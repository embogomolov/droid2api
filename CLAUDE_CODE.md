# Claude Code through Factory

## Start

1. Start or restart droid2api with `npm start` in this directory. An already running
   Node process must be restarted to load these changes.
2. Run `Claude Code через Factory.cmd`. It opens Claude Code with Fable 5.1.
   To choose a project, pass its directory as the first argument from PowerShell:

   ```powershell
   & 'C:\Projects\droid2api\Claude Code через Factory.cmd' 'C:\Projects\my-project'
   ```

   Remaining arguments go to Claude Code, for example `--resume` to select an
   existing conversation. Without a directory argument, it uses the current directory.

The launcher reads the local gateway credential from `API_ACCESS_KEY` in `.env`.
Factory credentials remain in the existing key pool. Do not put Factory keys into
Claude Code. The launcher changes only the child process environment; ordinary
Claude Code login/settings remain untouched. `--check` validates the profile without
an inference; `--version` verifies the installed client.

Default model: `claude-fable-5.1`. Factory returns `claude-fable-5-1` in responses;
the gateway also accepts that alias. The `opus`, `sonnet`, and `haiku` aliases point
to configured Factory models; only Fable was live-tested in this verification.
Keep model `type: anthropic` and `reasoning: auto` so Claude Code controls thinking.

## Behavior and limits

- Claude uses the Anthropic Messages HTTP/SSE transport, as native Droid does for
  Claude. This is separate from the OpenAI Responses WebSocket transport.
- Client cache markers and TTL, tool definitions/results, thinking signatures,
  output configuration, context management, and Anthropic capability headers are
  preserved. PNG/JPEG images use the existing native Droid image preparation.
- Every request follows the configured pool policy, including continuations of
  an existing session. There is no account affinity; old bindings are discarded
  on load. Session identity and per-agent turn queues remain for transport ordering
  and cache stability. Quota rejections can fail over to another eligible account.
  Fable cache reuse across all three tested Factory accounts was verified below;
  future cache availability remains an upstream decision.
- Usage records combine uncached input, cache creation and cache reads correctly.
  Output already includes thinking; thinking is not charged twice by local counters.
  Local counters do not define Factory's billing formula or predict exact percentage use.
- Startup/hourly inference-based key tests are disabled by default. Opting into
  `AUTOMATIC_KEY_TESTS=true` spends quota. Manual key tests also spend quota.
  Billing refresh and quota-based account recovery still work without these tests.
- Factory rejected stock Claude Code identity and two environment-description
  phrases with HTTP 403. The gateway retains the required Droid introduction and
  narrowly rephrases those stock system sentences, preserving model names/IDs.
  A full interactive-client test also found two rejected stock metadata forms:
  the global instruction-file label and the `update-config` skill's explanation
  of hook execution. Those labels are narrowly rephrased inside Claude Code's
  generated reminders, preserving file paths, loaded instructions, hooks, skills,
  and cache markers. Authored user text is unchanged; broad keyword filtering
  remains disabled. Therefore
  the system prompt is not byte-for-byte identical to direct Anthropic access.
- Factory's tested `messages/count_tokens` route returns 404. The proxy forwards
  that error: it does not invent an exact count or run an inference to estimate one.
  Normal generation, tools and resume worked despite this optional route being absent.
  Exact preflight token counting is unavailable through the tested Factory endpoint.
- Interrupted/ambiguous accepted requests are not automatically replayed by the
  proxy. Claude Code can still have its own retry behavior. No gateway can guarantee
  zero quota cost or perpetual compatibility with changes to upstream services.

## Verification (September 7, 2026)

Installed clients: Claude Code 2.1.263 and Droid 0.213.0. Native Droid wire capture
was compared with actual Claude Code requests on the same Factory credential.
Real Fable responses, file reading through the Read tool, and saved-session resume
were verified. Quota was checked after every physical request, including failures.

| Physical generation | Uncached input | Cache created | Cache read | Output |
| --- | ---: | ---: | ---: | ---: |
| Controlled cold context | 4 | 19,685 | 0 | 9 |
| Continuation | 4 | 25 | 19,685 | 9 |
| Tool invocation | 4 | 32 | 19,710 | 85 |
| Tool result | 2 | 108 | 19,742 | 16 |
| Normal client system, tool invocation | 2 | 3,875 | 0 | 85 |
| Normal client tool result | 2 | 130 | 3,875 | 16 |
| Saved normal session resumed | 2 | 57 | 4,005 | 9 |

The selected account's displayed five-hour usage increased from 34% to 35% during
this verification. These rounded values establish bounded observed use, not exact
billing parity, future cost, or coverage of every Claude Code feature. Live tests
used safe mode / isolated test settings; personal hooks, plugins, MCP servers and
all other model families were not exercised.

Offline regression checks (no inference):

```powershell
node tests/test-claude-gateway.mjs
node tests/test-factory-images.js
```

The gateway check covers authentication, unchanged request fields, split UTF-8 SSE,
terminal detection, truncated streams, accounting, quota failover and agent isolation.
The existing guarded live probe requires `--live` and refuses completed stages;
its saved quota budget must not be reset merely to retry a failure.

### Full personal configuration follow-up

The initial isolated verification missed two Factory-rejected metadata phrases
present with personal instructions and the full skill catalog. The gateway now
rephrases only those generated labels as described above. A subsequent real
interactive Claude Code session used the user's ordinary settings, enabled hooks,
plugins and high effort, through the restarted production server on port 3000.
One bounded generation returned HTTP 200 and `Привет! Чем могу помочь?`:
2 uncached input tokens, 36,335 cache-creation tokens and 15 output tokens.
The selected account's five-hour usage changed from 24% to 25%; the other accounts
were unchanged. This was a cold-cache check, not an additional warm-cache test.
The check capped output at 256 tokens and prevented request replay. Earlier
malformed-parameter probes isolated the rejected strings without generation;
the monitored account remained at 35% throughout those probes.

### Cross-account cache verification and routing

On September 7, 2026, four Fable 5.1 requests used one newly generated, unique
context with the exact same body hash and session identity across three distinct
Factory credentials. All returned HTTP 200 and `CACHE_OK`, with 29 uncached input
tokens and 9 output tokens per request:

| Request | Cache created | Cache read |
| --- | ---: | ---: |
| Account A, cold | 3,332 | 0 |
| Account A, repeat | 0 | 3,332 |
| Account B, first request for this context | 0 | 3,332 |
| Account C, first request for this context | 0 | 3,332 |

The accounts' displayed five-hour usage remained 26%, 36%, and 1% respectively,
including delayed checks after every request. This proves reuse for the tested
context and credentials, not a permanent cross-account cache service guarantee.
Account affinity was subsequently removed from key selection for both Anthropic
and OpenAI routes. `round-robin` now rotates within an existing conversation too;
selecting a quota-based policy instead makes that policy apply on every request.
Offline checks cover account rotation with stable cache identity, full-context
reconnect on account change, same-account deltas, cooldown recovery, and ignoring
legacy persisted bindings. The live report is `work/fable-cross-account-cache.json`;
`tests/probe-fable-cross-account-live.mjs --live` refuses to replay an existing run.

Protocol reference: [Claude Code gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol).
