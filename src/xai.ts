import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const XAI_BASE_URL = "https://api.x.ai/v1"
export const XAI_OAUTH_ISSUER = "https://auth.x.ai"
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access"
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1"
export const XAI_OAUTH_REDIRECT_PORT = 56121
export const XAI_OAUTH_REDIRECT_PATH = "/callback"
export const REFRESH_SKEW_MS = 2 * 60 * 1000

export type StoredAuth = {
  provider: "xai-oauth"
  access: string
  refresh: string
  expires: number
  tokenEndpoint: string
  tokenType: string
}

export type XaiCredentials = {
  provider: "xai-oauth" | "xai"
  apiKey: string
  baseUrl: string
}

type Discovery = { authorization_endpoint: string; token_endpoint: string }
type TokenPayload = { access_token?: string; refresh_token?: string; expires_in?: number; token_type?: string }

type CallbackResult = { code?: string; state?: string; error?: string; error_description?: string }

function configHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
}

export function defaultAuthPath() {
  return join(configHome(), "opencode", "xai-oauth", "auth.json")
}

export function legacyAuthPath() {
  return join(configHome(), "opencode-xai-oauth", "auth.json")
}

export function authPath() {
  return process.env.OPENCODE_XAI_OAUTH_AUTH_FILE || defaultAuthPath()
}

function readableAuthPath() {
  const configured = authPath()
  if (process.env.OPENCODE_XAI_OAUTH_AUTH_FILE || existsSync(configured)) return configured
  const legacy = legacyAuthPath()
  return existsSync(legacy) ? legacy : configured
}

export function readStoredAuth(path = readableAuthPath()): StoredAuth | undefined {
  if (!existsSync(path)) return undefined
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAuth>
    if (!data.access || !data.refresh || !data.expires || !data.tokenEndpoint) return undefined
    return {
      provider: "xai-oauth",
      access: String(data.access),
      refresh: String(data.refresh),
      expires: Number(data.expires),
      tokenEndpoint: String(data.tokenEndpoint),
      tokenType: String(data.tokenType || "Bearer"),
    }
  } catch {
    return undefined
  }
}

export function writeStoredAuth(auth: StoredAuth, path = authPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(auth, null, 2), { mode: 0o600 })
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function validateXaiEndpoint(url: string) {
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`xAI OAuth discovery returned an unexpected endpoint: ${url}`)
  }
  return url
}

export async function discoverXaiOAuth(): Promise<Discovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, { headers: { Accept: "application/json" } })
  if (!response.ok) throw new Error(`xAI OAuth discovery failed: ${response.status} ${await response.text()}`)
  const data = (await response.json()) as Partial<Discovery>
  if (!data.authorization_endpoint || !data.token_endpoint) throw new Error("xAI OAuth discovery response missing endpoints")
  return {
    authorization_endpoint: validateXaiEndpoint(data.authorization_endpoint),
    token_endpoint: validateXaiEndpoint(data.token_endpoint),
  }
}

function callbackCorsOrigin(origin: string | undefined) {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai" ? origin : undefined
}

export async function startCallbackServer(port = Number(process.env.OPENCODE_XAI_OAUTH_PORT || XAI_OAUTH_REDIRECT_PORT)) {
  let resolveCallback!: (result: CallbackResult) => void
  const callbackPromise = new Promise<CallbackResult>((resolve) => (resolveCallback = resolve))
  let server: Server | undefined

  await new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const origin = callbackCorsOrigin(req.headers.origin)
      const writeCors = () => {
        if (!origin) return
        res.setHeader("Access-Control-Allow-Origin", origin)
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")
        res.setHeader("Access-Control-Allow-Headers", "Content-Type")
        res.setHeader("Access-Control-Allow-Private-Network", "true")
        res.setHeader("Vary", "Origin")
      }
      if (req.method === "OPTIONS") {
        writeCors(); res.writeHead(204); res.end(); return
      }
      const url = new URL(req.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`)
      if (url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Not found"); return
      }
      const result = {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description: url.searchParams.get("error_description") || undefined,
      }
      resolveCallback(result)
      writeCors()
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      res.end("<html><body><h1>xAI OAuth complete</h1><p>You can close this tab and return to OpenCode.</p></body></html>")
    })
    server.once("error", reject)
    server.listen(port, XAI_OAUTH_REDIRECT_HOST, () => resolve())
  })

  return {
    redirectUri: `http://${XAI_OAUTH_REDIRECT_HOST}:${port}${XAI_OAUTH_REDIRECT_PATH}`,
    waitForCallback: (signal?: AbortSignal) => new Promise<CallbackResult>((resolve, reject) => {
      const onAbort = () => reject(new Error("OAuth login aborted"))
      if (signal?.aborted) return onAbort()
      signal?.addEventListener("abort", onAbort, { once: true })
      callbackPromise.then(resolve, reject).finally(() => signal?.removeEventListener("abort", onAbort))
    }),
    close: () => server?.close(),
  }
}

export async function exchangeCodeForToken(tokenEndpoint: string, code: string, verifier: string, redirectUri: string): Promise<StoredAuth> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: XAI_OAUTH_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  })
  if (!response.ok) throw new Error(`xAI token exchange failed: ${response.status} ${await response.text()}`)
  const token = (await response.json()) as TokenPayload
  if (!token.access_token || !token.refresh_token) throw new Error("xAI token response did not include access/refresh tokens")
  return {
    provider: "xai-oauth",
    access: token.access_token,
    refresh: token.refresh_token,
    expires: Date.now() + Number(token.expires_in || 3600) * 1000 - REFRESH_SKEW_MS,
    tokenEndpoint,
    tokenType: token.token_type || "Bearer",
  }
}

export async function refreshStoredAuth(auth: StoredAuth): Promise<StoredAuth> {
  const body = new URLSearchParams({ grant_type: "refresh_token", client_id: XAI_OAUTH_CLIENT_ID, refresh_token: auth.refresh })
  const response = await fetch(auth.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  })
  if (!response.ok) throw new Error(`xAI token refresh failed: ${response.status} ${await response.text()}`)
  const token = (await response.json()) as TokenPayload
  if (!token.access_token) throw new Error("xAI refresh response did not include an access token")
  return {
    provider: "xai-oauth",
    access: token.access_token,
    refresh: token.refresh_token || auth.refresh,
    expires: Date.now() + Number(token.expires_in || 3600) * 1000 - REFRESH_SKEW_MS,
    tokenEndpoint: auth.tokenEndpoint,
    tokenType: token.token_type || auth.tokenType || "Bearer",
  }
}

export async function resolveXaiCredentials(): Promise<XaiCredentials> {
  const stored = readStoredAuth()
  if (stored?.access) {
    const current = stored.expires <= Date.now() ? await refreshStoredAuth(stored).then((next) => (writeStoredAuth(next), next)) : stored
    return { provider: "xai-oauth", apiKey: current.access, baseUrl: process.env.XAI_BASE_URL || XAI_BASE_URL }
  }
  const apiKey = (process.env.XAI_API_KEY || "").trim()
  if (apiKey) return { provider: "xai", apiKey, baseUrl: process.env.XAI_BASE_URL || XAI_BASE_URL }
  throw new Error("xAI credentials not found. Run `opencode-xai-oauth login` or set XAI_API_KEY.")
}

export async function beginOAuth() {
  const discovery = await discoverXaiOAuth()
  const callback = await startCallbackServer()
  const state = randomBytes(16).toString("base64url")
  const { verifier, challenge } = pkcePair()
  const url = new URL(discovery.authorization_endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID)
  url.searchParams.set("redirect_uri", callback.redirectUri)
  url.searchParams.set("scope", XAI_OAUTH_SCOPE)
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return {
    url: url.toString(),
    instructions: "브라우저에서 xAI/Grok 로그인을 완료하세요. 원격 환경이면 redirect URL 전체를 복사해 CLI에 붙여넣으세요.",
    async complete(signal?: AbortSignal) {
      try {
        const result = await callback.waitForCallback(signal)
        if (result.error) throw new Error(result.error_description || result.error)
        if (!result.code || result.state !== state) throw new Error("Invalid xAI OAuth callback")
        const auth = await exchangeCodeForToken(discovery.token_endpoint, result.code, verifier, callback.redirectUri)
        writeStoredAuth(auth)
        return auth
      } finally {
        callback.close()
      }
    },
  }
}

async function xaiFetch(path: string, init: RequestInit = {}) {
  const creds = await resolveXaiCredentials()
  const response = await fetch(`${creds.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.apiKey}`,
      "User-Agent": "opencode-xai-oauth/0.1",
      ...(init.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  })
  if (!response.ok) throw new Error(`xAI request failed: ${response.status} ${await response.text()}`)
  return response
}

function responseText(payload: any) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim()
  const parts: string[] = []
  for (const item of payload.output || []) {
    if (item?.type !== "message") continue
    for (const content of item.content || []) {
      if ((content?.type === "output_text" || content?.type === "text") && content.text) parts.push(String(content.text))
    }
  }
  return parts.join("\n\n").trim()
}

function inlineCitations(payload: any) {
  const citations: any[] = []
  for (const item of payload.output || []) {
    if (item?.type !== "message") continue
    for (const content of item.content || []) {
      for (const annotation of content.annotations || []) if (annotation?.type === "url_citation") citations.push(annotation)
    }
  }
  return citations
}

export async function xaiResponses(input: { prompt: string; model?: string; tools?: any[]; reasoningEffort?: "low" | "medium" | "high"; timeoutMs?: number }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs || 180_000)
  try {
    const response = await xaiFetch("/responses", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model || "grok-4.3",
        input: [{ role: "user", content: input.prompt }],
        ...(input.tools?.length ? { tools: input.tools } : {}),
        ...(input.reasoningEffort ? { reasoning: { effort: input.reasoningEffort } } : {}),
        store: false,
      }),
    })
    const payload = await response.json()
    return { payload, text: responseText(payload), citations: payload.citations || [], inline_citations: inlineCitations(payload) }
  } finally {
    clearTimeout(timer)
  }
}

export async function xaiImageGenerate(args: { prompt: string; model?: string; n?: number; size?: string; resolution?: "1k" | "2k"; response_format?: "url" | "b64_json" }) {
  const body: Record<string, unknown> = {
    model: args.model || "grok-imagine-image",
    prompt: args.prompt,
    n: args.n || 1,
    response_format: args.response_format || "url",
  }
  if (args.resolution) body.resolution = args.resolution
  if (args.size) body.size = args.size
  const response = await xaiFetch("/images/generations", {
    method: "POST",
    body: JSON.stringify(body),
  })
  return response.json()
}

export async function xaiTts(args: { input: string; voice?: string; voice_id?: string; language?: string; format?: string; codec?: string; sample_rate?: number; bit_rate?: number; text_normalization?: boolean }) {
  const codec = args.codec || args.format
  const body: Record<string, unknown> = {
    text: args.input,
    voice_id: args.voice_id || args.voice || "eve",
    language: args.language || "auto",
  }
  if (codec || args.sample_rate || args.bit_rate) {
    body.output_format = {
      ...(codec ? { codec } : {}),
      ...(args.sample_rate ? { sample_rate: args.sample_rate } : {}),
      ...(args.bit_rate ? { bit_rate: args.bit_rate } : {}),
    }
  }
  if (typeof args.text_normalization === "boolean") body.text_normalization = args.text_normalization

  const response = await xaiFetch("/tts", {
    method: "POST",
    body: JSON.stringify(body),
  })
  const bytes = Buffer.from(await response.arrayBuffer())
  return { bytes, contentType: response.headers.get("content-type") || `audio/${codec || "mpeg"}` }
}

export async function xaiVideoGenerate(
  args: {
    prompt: string
    model?: string
    duration?: number
    aspect_ratio?: string
    resolution?: "480p" | "720p"
    image_url?: string
    reference_image_urls?: string[]
  },
  testOpts?: { pollIntervalMs?: number; maxWaitMs?: number },
) {
  const idempotencyKey = randomUUID()
  const body: Record<string, unknown> = {
    model: args.model || "grok-imagine-video",
    prompt: args.prompt,
    duration: typeof args.duration === "number" ? args.duration : 8,
    aspect_ratio: args.aspect_ratio || "16:9",
    resolution: args.resolution || "720p",
  }
  if (args.image_url) {
    body.image = { url: args.image_url }
  }
  if (args.reference_image_urls && args.reference_image_urls.length > 0) {
    body.reference_images = args.reference_image_urls.map((url) => ({ url }))
  }

  // Submit generation request (Hermes reference: uses /videos/generations + idempotency key)
  const submitRes = await xaiFetch("/videos/generations", {
    method: "POST",
    headers: { "x-idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  })
  const submitJson = (await submitRes.json()) as { request_id?: string }
  const requestId = submitJson.request_id
  if (!requestId) {
    throw new Error("xAI video submit response did not include request_id")
  }

  // Poll until done / failed / expired (modeled on Hermes XAIVideoGenProvider._poll)
  const TIMEOUT_MS = testOpts?.maxWaitMs ?? 300_000 // 5 minutes
  const POLL_INTERVAL_MS = testOpts?.pollIntervalMs ?? 5000
  const start = Date.now()
  while (Date.now() - start < TIMEOUT_MS) {
    const pollRes = await xaiFetch(`/videos/${encodeURIComponent(requestId)}`, {
      method: "GET",
    })
    const data = (await pollRes.json()) as {
      status?: string
      video?: { url?: string; duration?: number }
      error?: { message?: string }
      message?: string
      model?: string
    }
    const status = String(data.status || "").toLowerCase()

    if (status === "done") {
      return { request_id: requestId, ...data }
    }
    if (["failed", "expired", "error", "cancelled"].includes(status)) {
      const errMsg = data.error?.message || data.message || `ended with status ${status}`
      throw new Error(`xAI video generation ${status}: ${errMsg}`)
    }
    // pending / processing / queued etc.
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`xAI video generation timed out after ${Math.floor(TIMEOUT_MS / 1000)}s (request_id=${requestId})`)
}

/**
 * Download a remote media URL (image or video) and save it locally under the project's
 * `.opencode/artifacts/` directory. Returns the absolute path to the saved file.
 *
 * This allows OpenCode to display the media as a persistent popup/attachment
 * even after the temporary xAI CDN URL expires.
 */
export async function downloadMediaToArtifacts(
  url: string,
  filename: string,
  worktree: string,
): Promise<string> {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")

  const artifactsDir = join(worktree, ".opencode", "artifacts")
  mkdirSync(artifactsDir, { recursive: true })

  const filePath = join(artifactsDir, filename)

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to download media: ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  writeFileSync(filePath, buffer)

  return filePath
}

/**
 * Save a base64-encoded image (from xAI when response_format=b64_json) to the artifacts folder.
 */
export async function saveBase64Image(
  b64Data: string,
  filename: string,
  worktree: string,
): Promise<string> {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")

  const artifactsDir = join(worktree, ".opencode", "artifacts")
  mkdirSync(artifactsDir, { recursive: true })

  const filePath = join(artifactsDir, filename)
  const buffer = Buffer.from(b64Data, "base64")
  writeFileSync(filePath, buffer)

  return filePath
}
