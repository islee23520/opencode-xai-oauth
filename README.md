# opencode-xai-oauth

OpenCode plugin that adds xAI/Grok OAuth credentials plus xAI-powered tools for text, web search, X search, TTS, and image generation.

## What it provides

- `auth` hook attaches OAuth/API-key login methods to the existing OpenCode `xai` provider, so `opencode auth login` shows only the normal xAI provider path.
- Does **not** override OpenCode's built-in `xai` provider/model adapter; this avoids adapter mismatches such as `responses is not a function`.
- `shell.env` hook that injects `XAI_API_KEY`/`XAI_BASE_URL` into tool shells when credentials are available.
- Custom OpenCode tools:
  - `xai_status`
  - `xai_generate_text`
  - `xai_web_search`
  - `xai_x_search`
  - `xai_image_generate`
  - `xai_tts`

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

## Development

```bash
bun install
bun test
bun run typecheck
bun run build
```
