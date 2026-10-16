<div align="center">

# opencode2dsh-improve

**Free OpenCode Zen models, natively inside DSH (DeepSeek Harness).**

No API key. No registration. A managed local runtime drives the free lane.

[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/wozhenming/opencode2dsh-improve/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-blue)](https://github.com/wozhenming/opencode2dsh-improve)

English | [简体中文](README.zh-CN.md)

</div>

---

opencode2dsh registers a native DSH `LlmAdapter` that streams directly from
[OpenCode Zen](https://opencode.ai/zen)'s **anonymous free lane** — the same
models OpenCode's own CLI uses without an account, served to your DSH model
picker as a regular provider called `opencode2dsh`.

Requests leave your machine looking exactly like traffic from the OpenCode
CLI (same user agent, same correlation headers), and the model catalog stays
fresh through a three-tier fallback chain. There is nothing to log into and
nothing to host.

## This fork: delegated runtime & live streaming

This repository (`wozhenming/opencode2dsh-improve`) is a fork of
[opencode2dsh](https://github.com/FishBottle7/opencode2dsh) that keeps the
plugin usable after Zen started refusing free-tier requests from anything that
is not a genuine OpenCode runtime (`403 FreeTierError`), and that restores
real streaming — including the model's reasoning.

```
DSH session → ZenAdapter → loopback shim → isolated `opencode serve` → Zen free models
```

**Improvements over upstream**

- **403 fixed by delegating to a real runtime** — a managed, isolated
  `opencode serve` (official `opencode-ai` binary, version-checked,
  auto-discovered or downloaded) runs inside its own XDG data directory
  (`~/.opencode2dsh/delegate`) and is exposed to the unchanged adapter through a
  loopback OpenAI-compatible shim. Zen sees genuine OpenCode traffic, so the
  free models work again. The lane also seeds your Zen credentials when
  present, absorbs the one-time refusal a virgin data directory gets on its
  first inference (warm-up, plus a single runtime restart), caps runtime memory
  (`GOMEMLIMIT=96MiB`, `GOGC=30`) and trims its Windows working set.
  On by default; set `delegate: false` to return to the direct lane.
- **Live streaming, thinking included** — upstream buffered the whole turn and
  emitted one SSE burst with the final text only. This fork forwards the
  runtime's event stream as it arrives: reasoning becomes `reasoning_content`
  (so DSH renders a live thinking block), the answer is extracted incrementally
  from the JSON envelope while the model writes it, and tool calls are still
  emitted only after validation. Correction retries continue the same stream,
  and the user-message text the runtime echoes back is filtered out.

**Depended projects**

| Project | Role here | License |
| --- | --- | --- |
| [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) | Upstream plugin this repository forks (adapter, catalog, disguise) | MIT © FishBottle7 |
| [XDTrees/dsh-opencode-xdbridge](https://github.com/XDTrees/dsh-opencode-xdbridge) | Runtime/shim/protocol core vendored under `lib/delegate/` — see `lib/delegate/LICENSE-xdbridge` | MIT © XDTrees |
| [OpenCode](https://opencode.ai) (`opencode-ai`) | The real runtime the delegate lane drives | MIT |
| [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) | Wire layer used by the adapter | MIT © Mario Zechner |
| [opencode2api](https://github.com/jasonxu114514/opencode2api) | Origin of the anonymous-lane catalog and disguise details in upstream | — |
| [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) · [dsh-market](https://github.com/dsh-market/dsh-market) | Host platform and plugin market | — |

**Install from this fork** — in DSH open **Settings → Plugins** and enter
`github:wozhenming/opencode2dsh-improve` (or
`https://github.com/wozhenming/opencode2dsh-improve`); a pinned commit works
too: `github:wozhenming/opencode2dsh-improve#<sha>`. It installs as the plugin
package `opencode2dsh-improve` (that is also the Plugins page entry); the
model-picker provider id stays `opencode2dsh` unless you override
`providerId`. Remove upstream `@opencode2dsh/dsh-plugin` first — installing
both would collide (same provider route and delegate runtime).

## Highlights

- **Zero credential, zero setup** — the anonymous lane needs no key; install, restart, chat
- **Native adapter, no sidecar** — one npm package, no child process, no binary, no local port (the legacy Go sidecar is not part of the published package; see `legacy/`). This fork's default lane adds a managed, isolated `opencode serve` (see above); set `delegate: false` for the upstream direct lane.
- **CLI-identical disguise** — requests carry the OpenCode CLI user agent and its session/request/project header set, derived per conversation
- **Selectable thinking levels** — reasoning-capable free models expose an effort picker in DSH's model selector (declared ladders where the model metadata provides them, Off/Minimal/Low/Medium/High otherwise); Responses-only `muse-spark-*` models expose only upstream-supported effort levels, and no selection keeps the provider default
- **Image input where it is declared** — image attachments are accepted for every model whose [models.dev](https://models.dev) entry lists `image` in `modalities.input`, and refused for the ones that declare `text` only; models.dev being silent falls back to the live-verified vision family
- **Live catalog with a fallback chain** — live upstream list ∩ free-by-metadata, falling back to offline cache and a verified static list
- **Self-healing** — fast startup retries, periodic refresh, and a written health snapshot for diagnostics
- **Proper error surfaces** — upstream failures (rate limit, auth, timeout, transport) arrive in DSH as classified finish reasons, and retries stay owned by DSH

## Install

**From this repository (recommended for this fork)** — in DSH open
**Settings → Plugins** and enter `github:wozhenming/opencode2dsh-improve`
(or `https://github.com/wozhenming/opencode2dsh-improve`); from a terminal:

```sh
dsh plugin --profile web add github:wozhenming/opencode2dsh-improve
```

No build step: this repository ships the built `lib/` and has no `prepare`
script, so a git install consumes it as-is. Installing writes the plugin as
`opencode2dsh-improve`; the Plugins page row and the model-picker provider are
described in the fork section above.

**Upstream release (npm)** — `dsh plugin --profile web add
@opencode2dsh/dsh-plugin` installs FishBottle7's published build, not this
fork. The plugin market's `opencode2dsh` entry is that same upstream release;
it does not carry the delegate lane or live streaming.

**Verify**: restart DSH, open the model picker, and pick a model from the
**opencode2dsh** group (the provider id is unchanged by this fork).

Requires DSH (DeepSeek Harness) 0.1.7 or newer with a web profile (the IP 池
settings page rides the 0.1.7 Plugins page contract); Node.js ≥ 20 (already
present if DSH runs); outbound HTTPS to `opencode.ai` and `models.dev`, plus —
on the delegate lane's first run — `registry.npmjs.org` or `github.com` to
fetch and verify the managed `opencode` runtime (cached under
`~/.opencode2dsh/delegate` and reused afterwards).

## First start (installed from a GitHub link)

On a fresh machine the delegated runtime is usually **not** ready by the time
the first message is sent: it downloads the ~60 MB `opencode` runtime (resumable
across restarts), starts the service, reads the free-model catalog, and — for a
new data directory — warms up once (Zen refuses the very first inference on a
virgin directory, and the plugin restarts the runtime and retries by itself).

- While the runtime is not ready, requests now answer with the real reason
  instead of a timeout: `委托运行时仍在准备（正在下载 OpenCode：12.3 / 60.2 MB）……
  请稍后重试`, or `委托运行时准备失败：<reason>`. Retry once the log shows
  `delegated OpenCode runtime ready`.
- To let the first message wait longer, set `delegateStartWaitMs` (milliseconds,
  default `90000`, range `1000`–`600000`).
- If the download is slow or rate-limited, make `HTTPS_PROXY` (or `HTTP_PROXY`)
  visible to the **DSH process**: the plugin reads those variables and tunnels
  itself, but a GUI-launched DSH does not inherit the system proxy.
- With no usable route to the download sources, point
  `OPENCODE_XDBRIDGE_RUNTIME_URL=<local tgz or internal mirror>` at a local copy
  of the runtime archive (source probing is skipped).
- On a small machine raise the runtime heap with
  `OPENCODE2DSH_GOMEMLIMIT=192MiB` (default `96MiB`).

## Configuration

Defaults work out of the box. Override via the profile's `cordis.patch.yml`:

```yaml
- id: opencode2dsh-improve
  name: 'opencode2dsh-improve'
  config:
    mode: adapter        # adapter (default) | sidecar
    providerId: opencode2dsh
    refreshSeconds: 300  # catalog refresh cadence
```

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `adapter` | `adapter`: native LlmAdapter streaming straight from Zen. `sidecar`: legacy local-agent mode, not bundled — build the agent from `legacy/agent` and pass `agentPath`. |
| `providerId` | `opencode2dsh` | Provider name shown in DSH. |
| `refreshSeconds` | `300` | Live catalog refresh interval. Pricing metadata refreshes every 24 h. |
| `agentPath` | auto-resolved | Sidecar only: path to the agent binary. |
| `agentArgs` | — | Sidecar only: extra CLI args for the agent. |
| `restartDelayMs` / `restartMaxDelayMs` / `maxConsecutiveCrashes` | `1000` / `60000` / `5` | Sidecar only: restart backoff and circuit breaker. |
| `firstEventMs` / `bodyIdleMs` / `responsesBodyIdleMs` | `30000` / `120000` / `300000` | Adapter only, plugin 0.3.7+: stream-liveness watchdogs, in ms (integers from `1` to `600000`). Time to the first stream event, mid-response body silence, and the body-idle floor for Responses models (`muse-spark-*`). Increase `firstEventMs` for slow cold starts. Unset keeps the defaults; restart DSH after editing. |
| `delegate` | `true` | This fork only: run the managed, isolated OpenCode runtime (the fix for the free-tier 403) instead of the upstream direct lane. |
| `delegateStartWaitMs` | `90000` | This fork only: how long one request waits for the managed runtime to come up (`1000`–`600000`). While it is still downloading or prewarming, the request fails with the runtime's current status instead of a generic timeout. |
| `delegateDataDir` | `~/.opencode2dsh/delegate` | This fork only: data directory of the managed runtime, shim and logs. |
| `delegateBinaryPath` / `delegateRuntimeVersion` | auto-resolved / latest known | This fork only: point at a specific `opencode` binary, or pin a runtime version. |

## How it works

```
DSH session
   │  harness chunks (block-start / text-delta / usage / finish …)
   ▼
ZenAdapter (registered LlmAdapter)
   │  pi-ai openai-completions stream (chat models)
   │  pi-ai openai-responses stream (`muse-spark-*`, Responses-only on Zen)
   ▼
https://opencode.ai/zen/v1        ← Authorization: Bearer public
   with CLI-identical headers:
     user-agent: opencode/…
     x-opencode-client, x-opencode-session, x-session-affinity,
     X-Session-Id, x-opencode-request, x-opencode-project
```

- **Session correlation** — session/project ids are SHA-256 derived from the
  conversation's first user turn (stable per conversation, non-reversible),
  and each request gets a fresh random id, mirroring the CLI.
- **Catalog fallback chain** — S1: live `GET /v1/models`; S2: models.dev
  pricing metadata decides "free"; S3: a compile-time verified static list.
  A disk cache (~7-day TTL) covers upstream outages.
- **Resilience** — the adapter registers immediately at startup; if the first
  catalog fetch races your network (VPN/TUN reconnects, DNS), the plugin
  retries on a short cadence (~1 min) before settling into the periodic
  refresh.
- **Sidecar mode** (`mode: sidecar`, legacy) — spawns a local Go agent (a
  single-tenant port of [opencode2api](https://github.com/jasonxu114514/opencode2api))
  on `127.0.0.1:<random>`, token-authenticated, and registers a standard
  `llm-pi-ai` route. **Not part of the published package**; build it from
  `legacy/agent` (`go build ./cmd/agent`) and point `agentPath` at the binary.

## Health & troubleshooting

The plugin writes a health snapshot after every refresh round:

```
~/.opencode2dsh/adapter-status.json
```

```json
{
  "status": "ready",
  "total": 64,
  "exposed": 9,
  "lastError": "",
  "writtenAt": "2026-08-29T07:01:54.915Z"
}
```

| Symptom | Likely cause & fix |
| --- | --- |
| `403 FreeTierError` / "OpenCode's free tier can only be used from within OpenCode" | Upstream only lets a genuine OpenCode runtime use the free lane. **This fork fixes it by default**: the delegate lane runs a real isolated `opencode serve`, so this error should no longer appear. If it still does, check `~/.opencode2dsh/delegate/opencode.log`; with `delegate: false` the upstream explanation applies (use the supported OpenCode client or an official API service). |
| Boot screen shows `Failed to load plugins … list slot "plugins.item" requires options.id`, or the IP 池 entry has no configuration page | Your DSH predates the 0.1.7 Plugins page contract. Upgrade DSH to 0.1.7 (latest recommended). On 0.1.6 and older the page never mounts (it is gated on `configForms.whileServed`) — model routing is unaffected. |
| DSH 0.1.7/0.2 cannot start after plugin installation (`pending … settingsScope`) | Upgrade the plugin to 0.3.5. On DSH 0.2, configure IP pooling through the installed opencode2dsh-improve row on the Plugins page. |
| Only 3 models | Startup fetch raced your network; retries land within ~1 min. Check `adapter-status.json` for `lastError`. |
| `lastError: "fetch failed"` persisting | Outbound HTTPS to `opencode.ai` blocked; check proxy/VPN rules. |
| Rate-limit errors in chat (`429 … Endpoint is unavailable`) | The anonymous lane is quota-per-IP and free models are contended. Since the fix for [#51](https://github.com/FishBottle7/opencode2dsh/issues/51) the plugin's provider retry policy rides out 429 bursts silently (8 retries, ~1s→20s backoff, ≈90s worst case per step) instead of surfacing them; when contention still wins, lower the reasoning effort, pick a less contended `-free` model, or enable IP pooling (multi-exit rotation) on the plugin settings page. |
| Output limit reached after reasoning with no answer | Plugin 0.3.6 retries once with thinking Off when the model supports it. Any answer text or tool-call event prevents replay. The retry preserves the original output cap and may still fail; both requests' usage is counted. Models without Off, including Muse, require a manual change of settings or model. |
| Muse reports `REGION_BLOCKED` / "This model is not available in your country" | Zen has rejected the current network region for this model. Plugin 0.3.5 preserves that explanation; older versions mislabeled the same 403 as an invalid API key. The anonymous lane does not need a personal key. Use a model available in your region. |
| Connection error to `127.0.0.1:*` | A stale sidecar route shadows the adapter; plugin ≥ 0.2.1 removes it at startup. |
| Install fails with `ERR_PNPM_IGNORED_BUILDS` | A transitive dependency of `pi-ai` (`@google/genai`, `protobufjs`) has build scripts that are not needed at runtime. Approve-or-decline them via the plugin market, or set both to `false` under `allowBuilds:` in the profile's `pnpm-workspace.yaml`. |

Note: versions named in the table (`0.3.x`) refer to upstream releases; this
fork is based on upstream 0.3.12 (manifest version `0.4.0`) and ships every
0.3.x fix listed above, plus the delegate lane and live streaming.

## Security

- No secrets involved: the anonymous lane's key is the literal string `public`; nothing is stored, nothing telemetry.
- Install paths restricted to `lib/` only; no build scripts run from dependencies.
- All requests go directly from your machine to `opencode.ai` / `models.dev`.

## Development

This repository carries the built plugin (`lib/` only) — no source tree and no
build step; git installs consume `lib/` as-is. The fork's changes live in
`lib/delegate/`: the delegate lane (`index.js`, `runtime.js`, `backend.js`,
`shim.js`, `handoff.js`) and the live-streaming bridge (`stream.js` plus the
event forwarding in `backend.js`/`shim.js`).

Source development — `pnpm typecheck`, `pnpm test`, `pnpm build`, the legacy Go
sidecar under `legacy/agent`, and the porting docs — lives in the upstream
tree: [FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh).

## Acknowledgments

- [**opencode2api**](https://github.com/jasonxu114514/opencode2api) by
  [@jasonxu114514](https://github.com/jasonxu114514) — the legacy Go sidecar
  in `legacy/agent` is a port of its anonymous-lane implementation, and the
  catalog fallback chain and request-disguise details are derived from it.
  This project stands on its shoulders.
- [**dsh-opencode-xdbridge**](https://github.com/XDTrees/dsh-opencode-xdbridge) by
  [@XDTrees](https://github.com/XDTrees) — the delegated-runtime core vendored
  under `lib/delegate/`; the 403 fix and the live-streaming work in this fork are
  built on it (MIT).
- [OpenCode](https://opencode.ai) — for running the free anonymous Zen lane, and
  for the official runtime binary the delegate lane manages.
- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai) — the wire layer used by adapter mode.
- [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) and the
  [dsh-market](https://github.com/dsh-market/dsh-market) community.

## Friends

<div align="center">

**[LinuxDo](https://linux.do)** — 新的理想型社区 / a new ideal community

</div>

## License

[MIT](./LICENSE) © FishBottle7
