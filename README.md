# opencode-xai-oauth

OpenCode plugin that attaches OAuth/API-key authentication to OpenCode's built-in `xai` provider and adds xAI/Grok tools for text, web search, X search, TTS, image generation, and video generation.

Current release: `v1.1.5`.


## Release notes

### v1.1.5

- Adds runtime `chat.headers` credential reload so expired OAuth tokens refresh during active xAI/Grok chat use without restarting OpenCode.
- Preserves OpenCode-managed xAI auth when this plugin has no reloadable OAuth/API-key credentials.
- Fails closed when an expired OAuth refresh fails instead of silently reusing stale plugin-managed credentials.
- Keeps package, CLI, and request user-agent version metadata aligned for release diagnostics.

### v1.1.4

- Adds Biome/Ultracite linting and formatting configuration.
- Adds `lint`, `lint:fix`, and `format` scripts for local development.
- Adds GitHub Actions CI for frozen install, lint, typecheck, tests, and build.
- Keeps the v1.1.3 OAuth refresh/storage fixes intact after resolving PR #1 against current `main`.

### v1.1.3

- Stores OAuth credentials in the OpenCode config area by default: `~/.config/opencode/xai-oauth/auth.json`.
- Preserves compatibility with the previous `~/.config/opencode-xai-oauth/auth.json` location when the new file is absent.
- Keeps `OPENCODE_XAI_OAUTH_AUTH_FILE` as the highest-priority custom auth-file override.
- Refreshes expired OAuth credentials before returning xAI provider credentials to avoid stale Grok sessions.
- Adds regression coverage for OAuth refresh and auth-file path behavior.

## Unofficial / Use at your own risk

⚠️ Experimental project. Uses consumer OAuth for personal use. Not affiliated with or endorsed by xAI. Use the official xAI API for production.

This is an unofficial community plugin and is not affiliated with, endorsed by, or supported by xAI. Use it at your own risk. You are responsible for reviewing and complying with the applicable xAI terms, policies, account rules, and API/service documentation before using OAuth, API keys, Grok, X Search, web search, image generation, or TTS through this plugin.

Relevant xAI terms may change over time. Start with xAI's Terms of Service: https://x.ai/legal/terms-of-service

This project does not provide legal advice and does not guarantee that any particular use of this plugin complies with xAI's Terms of Service, API terms, X terms, or other applicable policies.

## What it provides

- `auth` hook attaches OAuth/API-key login methods to the existing OpenCode `xai` provider, so `opencode auth login` uses the normal **xAI** provider instead of creating a separate `xai-oauth` provider.
- Does **not** override OpenCode's built-in `xai` provider/model adapter; this avoids adapter mismatches such as `responses is not a function`.
- Adds Grok thinking metadata to the built-in `xai` provider. `grok-4.3` exposes only xAI-supported reasoning effort variants: `low`, `medium`, and `high`.
- Marks `grok-4.20-reasoning` as reasoning-capable without sending unsupported `reasoning_effort` request parameters for that model.
- `shell.env` hook injects `XAI_API_KEY`/`XAI_BASE_URL` into tool shells when credentials are available.
- Custom OpenCode tools:
  - `xai_status`
  - `xai_generate_text`
  - `xai_web_search`
  - `xai_x_search`
  - `xai_image_generate`
  - `xai_tts`
  - `xai_video_generate`


## Supported features in v1.1.5

| Area | What works | Notes |
| --- | --- | --- |
| OpenCode auth | OAuth login and API-key fallback for provider `xai` | The plugin attaches to the existing xAI provider. |
| Grok chat/provider use | Uses OpenCode's built-in xAI adapter | The plugin only patches auth/config/params, not the provider adapter. |
| Grok thinking variants | `low`, `medium`, `high` for `grok-4.3` | Only xAI-supported reasoning effort values are exposed. |
| Grok 4.20 reasoning | Model is marked reasoning-capable | `reasoning_effort` is intentionally not sent for `grok-4.20-reasoning`. |
| Text generation tool | `xai_generate_text` | Uses xAI Responses API. |
| Web search tool | `xai_web_search` | Uses xAI server-side `web_search`. |
| X search tool | `xai_x_search` | Supports allowed/excluded handles, date bounds, and media-understanding flags. |
| Image generation tool | `xai_image_generate` | Calls xAI image generation endpoint. |
| TTS tool | `xai_tts` | Returns base64 audio in tool output. |
| Video generation tool | `xai_video_generate` | Calls xAI /videos/generations (async submit + poll); returns URL when ready. Text-to-video and image-to-video supported. |
| Shell integration | `XAI_API_KEY` and `XAI_BASE_URL` injection | Available after credentials resolve. |

## References used

- OpenCode plugin docs: plugins are TS/JS modules exporting plugin functions and can register custom tools with `tool()`.
- `pi-xai-oauth`: OAuth discovery, PKCE, localhost callback, xAI client id/scope, and `~/.grok/auth.json` compatibility ideas.
- Hermes Agent `x_search_tool.py` / `xai_http.py`: credential preference, xAI `/responses` usage, X-search handle normalization, response/citation extraction.

## Installation

### Via npm (recommended for end users)

Add the package to your OpenCode configuration (`~/.config/opencode/opencode.json` or per-project `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-xai-oauth"]
}
```

OpenCode automatically installs and loads npm plugins using Bun on startup (cached under `~/.cache/opencode/node_modules/`).

### Local development / from source

```bash
git clone https://github.com/islee23520/opencode-xai-oauth.git ~/.config/opencode/plugins/opencode-xai-oauth
cd ~/.config/opencode/plugins/opencode-xai-oauth
bun install
bun run build   # produces dist/ used by the package entry points
```

Restart OpenCode (or the TUI) after changes during development.

### CLI tool

After `npm install -g opencode-xai-oauth` (or from source with `bun link`):

```bash
opencode-xai-oauth login
opencode-xai-oauth status
```

For one-off use: `npx opencode-xai-oauth login` (requires Bun in PATH for the current CLI build).

## Authenticate

OAuth:

```bash
opencode-xai-oauth login
# or during local development:
bun run src/cli.ts login
```

OAuth tokens are stored under the OpenCode config area by default:

```text
~/.config/opencode/xai-oauth/auth.json
```

Existing installs with the previous `~/.config/opencode-xai-oauth/auth.json` file keep working; the plugin reads that legacy file when the new OpenCode config file is absent. To force a custom path, set `OPENCODE_XAI_OAUTH_AUTH_FILE`.

API key fallback:

```bash
export XAI_API_KEY=xai-...
```

Check status:

```bash
opencode-xai-oauth status
```


## Skill-like OpenCode commands

The plugin also injects command definitions through the config hook, and this repo's local OpenCode config includes matching markdown commands under `~/.config/opencode/commands/` for reliable TUI discovery:

| Command | Maps to tool | Purpose |
| --- | --- | --- |
| `/xai-status` | `xai_status` | Check credential availability without exposing secrets. |
| `/xai-text` | `xai_generate_text` | Generate text with Grok. |
| `/xai-web-search` | `xai_web_search` | Search the live web through xAI Responses API. |
| `/xai-x-search` | `xai_x_search` | Search X/Twitter through xAI Responses API. |
| `/xai-image` | `xai_image_generate` | Generate images with Grok Imagine. Images are saved locally + shown as rich popups via OpenTUI. |
| `/xai-tts` | `xai_tts` | Generate speech audio and return base64 output. |
| `/xai-video` | `xai_video_generate` | Generate videos (text-to-video, image-to-video, or with reference images). Saved locally + shown in OpenTUI popups. |

Examples:

```text
/xai-web-search latest xAI model news
/xai-x-search recent posts from @xai
/xai-image tiny minimalist blue dot icon on white background
/xai-tts hello from Grok
/xai-video a serene mountain lake at sunrise with slow camera pan, cinematic lighting
```

## Tool notes

- `xai_x_search` uses xAI Responses API with the server-side `x_search` tool. It supports allowed/excluded handles, date bounds, and image/video understanding flags.
- `xai_web_search` uses the server-side `web_search` tool.
- `xai_image_generate` calls `/images/generations`; default model is `grok-imagine-image`, with optional `resolution` (`1k` / `2k`) and `response_format` (`url` or `b64_json`).
  - Generated images (both URL and base64 responses) are automatically saved to `.opencode/artifacts/` and returned as `attachments` (with correct MIME) so OpenCode's OpenTUI-powered UI can display them in rich popups/previews. Supports `n > 1` for multiple images.
- `xai_tts` calls `/tts` and returns base64 audio in the tool output; default voice is `eve`, language is `auto`, and codec is `mp3`.
- `xai_video_generate` calls `/videos/generations` (modeled on Hermes XAIVideoGenProvider), polls until ready. Supports:
  - `image_url` — classic image-to-video
  - `reference_image_urls` — array of up to 7 reference images (for style/character consistency)
  - Videos (and reference-guided videos) are downloaded locally to `.opencode/artifacts/` and attached as `video/mp4` so OpenCode's OpenTUI UI renders them in a proper media popup/player.

Endpoint/model names can change on xAI's side; pass explicit `model` arguments if your account exposes different names.

## Grok thinking mode

The plugin patches OpenCode config metadata for the existing `xai` provider instead of replacing the provider adapter. For `grok-4.3`, OpenCode variants are mapped as follows. The plugin intentionally exposes only xAI-supported reasoning effort values, and writes both `reasoningEffort` and `reasoning_effort` into chat params for compatibility with OpenCode/xAI transport paths:

| OpenCode variant | xAI reasoning effort |
| --- | --- |
| `low` | `low` |
| `medium` | `medium` |
| `high` | `high` |

`grok-4.20-reasoning` is marked as a reasoning model, but the plugin intentionally does not send `reasoning_effort` for it because xAI documents that parameter as unsupported for `grok-4.20`.

## Development

```bash
bun install
bun run lint
bun test
bun run typecheck
bun run build
```
