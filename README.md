# opencode-xai-oauth

OpenCode plugin that attaches OAuth/API-key authentication to OpenCode's built-in `xai` provider and adds xAI/Grok tools for text, web search, X search, TTS, and image generation.

Current release: `v0.0.1`.

## What it provides

- `auth` hook attaches OAuth/API-key login methods to the existing OpenCode `xai` provider, so `opencode auth login` uses the normal **xAI** provider instead of creating a separate `xai-oauth` provider.
- Does **not** override OpenCode's built-in `xai` provider/model adapter; this avoids adapter mismatches such as `responses is not a function`.
- Adds Grok thinking metadata to the built-in `xai` provider. `grok-4.3` exposes `low`, `medium`, `high`, `xhigh`, and `max` variants; `xhigh` and `max` are mapped down to xAI's supported `high` reasoning effort.
- Marks `grok-4.20-reasoning` as reasoning-capable without sending unsupported `reasoning_effort` request parameters for that model.
- `shell.env` hook injects `XAI_API_KEY`/`XAI_BASE_URL` into tool shells when credentials are available.
- Custom OpenCode tools:
  - `xai_status`
  - `xai_generate_text`
  - `xai_web_search`
  - `xai_x_search`
  - `xai_image_generate`
  - `xai_tts`


## Supported features in v0.0.1

| Area | What works | Notes |
| --- | --- | --- |
| OpenCode auth | OAuth login and API-key fallback for provider `xai` | The plugin attaches to the existing xAI provider. |
| Grok chat/provider use | Uses OpenCode's built-in xAI adapter | The plugin only patches auth/config/params, not the provider adapter. |
| Grok thinking variants | `low`, `medium`, `high`, `xhigh`, `max` for `grok-4.3` | `xhigh` and `max` map to `high` because xAI exposes `low`/`medium`/`high`. |
| Grok 4.20 reasoning | Model is marked reasoning-capable | `reasoning_effort` is intentionally not sent for `grok-4.20-reasoning`. |
| Text generation tool | `xai_generate_text` | Uses xAI Responses API. |
| Web search tool | `xai_web_search` | Uses xAI server-side `web_search`. |
| X search tool | `xai_x_search` | Supports allowed/excluded handles, date bounds, and media-understanding flags. |
| Image generation tool | `xai_image_generate` | Calls xAI image generation endpoint. |
| TTS tool | `xai_tts` | Returns base64 audio in tool output. |
| Shell integration | `XAI_API_KEY` and `XAI_BASE_URL` injection | Available after credentials resolve. |

## References used

- OpenCode plugin docs: plugins are TS/JS modules exporting plugin functions and can register custom tools with `tool()`.
- `pi-xai-oauth`: OAuth discovery, PKCE, localhost callback, xAI client id/scope, and `~/.grok/auth.json` compatibility ideas.
- Hermes Agent `x_search_tool.py` / `xai_http.py`: credential preference, xAI `/responses` usage, X-search handle normalization, response/citation extraction.

## Install / load

This repo is already in the global OpenCode plugin directory:

```bash
~/.config/opencode/plugins/opencode-xai-oauth
```

For npm-style loading after publishing, add the package name to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-xai-oauth"]
}
```

## Authenticate

OAuth:

```bash
bun run src/cli.ts login
# or after linking the bin:
opencode-xai-oauth login
```

API key fallback:

```bash
export XAI_API_KEY=xai-...
```

Check status:

```bash
bun run src/cli.ts status
```

## Tool notes

- `xai_x_search` uses xAI Responses API with the server-side `x_search` tool. It supports allowed/excluded handles, date bounds, and image/video understanding flags.
- `xai_web_search` uses the server-side `web_search` tool.
- `xai_image_generate` calls `/images/generations`.
- `xai_tts` calls `/audio/speech` and returns base64 audio in the tool output.

Endpoint/model names can change on xAI's side; pass explicit `model` arguments if your account exposes different names.

## Grok thinking mode

The plugin patches OpenCode config metadata for the existing `xai` provider instead of replacing the provider adapter. For `grok-4.3`, OpenCode variants are mapped as follows. The plugin writes both `reasoningEffort` and `reasoning_effort` into chat params for compatibility with OpenCode/xAI transport paths:

| OpenCode variant | xAI reasoning effort |
| --- | --- |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |
| `xhigh` / `max` | `high` |

`grok-4.20-reasoning` is marked as a reasoning model, but the plugin intentionally does not send `reasoning_effort` for it because xAI documents that parameter as unsupported for `grok-4.20`.

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
