import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { PACKAGE_VERSION } from "./version";

export const XAI_BASE_URL = "https://api.x.ai/v1";
export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const XAI_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`;
export const XAI_OAUTH_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
export const XAI_OAUTH_DEVICE_AUTHORIZATION_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
export const XAI_OAUTH_REDIRECT_HOST = "127.0.0.1";
export const XAI_OAUTH_REDIRECT_PORT = 56_121;
export const XAI_OAUTH_REDIRECT_PATH = "/callback";
export const REFRESH_SKEW_MS = 2 * 60 * 1000;
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
const TRAILING_SLASH_REGEX = /\/$/;

function escapeHtmlValue(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

const HTML_SUCCESS = `<!doctype html>
<html>
  <head>
    <title>OpenCode - xAI Authorization Successful</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #f1ecec;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Successful</h1>
      <p>You can close this window and return to OpenCode.</p>
    </div>
    <script>
      setTimeout(() => window.close(), 2000)
    </script>
  </body>
</html>`;

const HTML_ERROR = (error: string) => `<!doctype html>
<html>
  <head>
    <title>OpenCode - xAI Authorization Failed</title>
    <style>
      body {
        font-family:
          system-ui,
          -apple-system,
          sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        background: #131010;
        color: #f1ecec;
      }
      .container {
        text-align: center;
        padding: 2rem;
      }
      h1 {
        color: #fc533a;
        margin-bottom: 1rem;
      }
      p {
        color: #b7b1b1;
      }
      .error {
        color: #ff917b;
        font-family: monospace;
        margin-top: 1rem;
        padding: 1rem;
        background: #3c140d;
        border-radius: 0.5rem;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Authorization Failed</h1>
      <p>An error occurred during authorization.</p>
      <div class="error">${escapeHtmlValue(error)}</div>
    </div>
  </body>
</html>`;

export interface StoredAuth {
  access: string;
  expires: number;
  provider: "xai-oauth";
  refresh: string;
  tokenEndpoint: string;
  tokenType: string;
}

export interface XaiCredentials {
  apiKey: string;
  baseUrl: string;
  provider: "xai-oauth" | "xai";
}

export interface DeviceCodeResponse {
  device_code: string;
  expires_in?: number;
  interval?: number;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
}

interface Discovery {
  authorization_endpoint: string;
  device_authorization_endpoint?: string;
  token_endpoint: string;
}
interface TokenPayload {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  token_type?: string;
}

interface CallbackResult {
  code?: string;
  error?: string;
  error_description?: string;
  state?: string;
}

interface DeviceTokenErrorBody {
  error?: string;
  error_description?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configHome() {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

export function defaultAuthPath() {
  return join(configHome(), "opencode", "xai-oauth", "auth.json");
}

export function legacyAuthPath() {
  return join(configHome(), "opencode-xai-oauth", "auth.json");
}

export function authPath() {
  return process.env.OPENCODE_XAI_OAUTH_AUTH_FILE || defaultAuthPath();
}

function readableAuthPath() {
  const configured = authPath();
  if (process.env.OPENCODE_XAI_OAUTH_AUTH_FILE || existsSync(configured)) {
    return configured;
  }
  const legacy = legacyAuthPath();
  return existsSync(legacy) ? legacy : configured;
}

export function readStoredAuth(
  path = readableAuthPath()
): StoredAuth | undefined {
  if (!existsSync(path)) {
    return;
  }
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredAuth>;
    if (!(data.access && data.refresh && data.expires && data.tokenEndpoint)) {
      return;
    }
    return {
      provider: "xai-oauth",
      access: String(data.access),
      refresh: String(data.refresh),
      expires: Number(data.expires),
      tokenEndpoint: String(data.tokenEndpoint),
      tokenType: String(data.tokenType || "Bearer"),
    };
  } catch {
    return;
  }
}

export function writeStoredAuth(auth: StoredAuth, path = authPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": `opencode-xai-oauth/${PACKAGE_VERSION}`,
  };
}

export function oauthExpiry(timestampSeconds?: number) {
  return Date.now() + Number(timestampSeconds || 3600) * 1000;
}

export function buildAuthorizeUrl(args: {
  authorizationEndpoint: string;
  challenge: string;
  nonce: string;
  redirectUri: string;
  state: string;
}) {
  const url = new URL(args.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", XAI_OAUTH_CLIENT_ID);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", XAI_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", args.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", args.state);
  url.searchParams.set("nonce", args.nonce);
  url.searchParams.set("plan", "generic");
  url.searchParams.set("referrer", "opencode");
  return url.toString();
}

export function accessTokenIsExpiring(
  token: string | undefined,
  skewMs: number = REFRESH_SKEW_MS
): boolean {
  if (!token || typeof token !== "string") {
    return false;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return false;
  }
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4 !== 0) {
      payload += "=";
    }
    const claims = JSON.parse(
      Buffer.from(payload, "base64").toString("utf8")
    ) as {
      exp?: unknown;
    };
    if (typeof claims.exp !== "number") {
      return false;
    }
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs);
  } catch {
    return false;
  }
}

function positiveSecondsToMs(value: unknown, defaultMs: number) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
}

export function escapeHtml(value: string): string {
  return escapeHtmlValue(value);
}

function validateXaiEndpoint(url: string) {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (host !== "x.ai" && !host.endsWith(".x.ai"))
  ) {
    throw new Error(
      `xAI OAuth discovery returned an unexpected endpoint: ${url}`
    );
  }
  return url;
}

export async function discoverXaiOAuth(): Promise<Discovery> {
  const response = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: {
      Accept: "application/json",
      "User-Agent": `opencode-xai-oauth/${PACKAGE_VERSION}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `xAI OAuth discovery failed: ${response.status} ${await response.text()}`
    );
  }
  const data = (await response.json()) as Partial<Discovery>;
  if (!(data.authorization_endpoint && data.token_endpoint)) {
    throw new Error("xAI OAuth discovery response missing endpoints");
  }
  return {
    authorization_endpoint: validateXaiEndpoint(
      data.authorization_endpoint || XAI_OAUTH_AUTHORIZE_URL
    ),
    device_authorization_endpoint: data.device_authorization_endpoint
      ? validateXaiEndpoint(data.device_authorization_endpoint)
      : XAI_OAUTH_DEVICE_AUTHORIZATION_URL,
    token_endpoint: validateXaiEndpoint(data.token_endpoint),
  };
}

function callbackCorsOrigin(origin: string | undefined) {
  return origin === "https://accounts.x.ai" || origin === "https://auth.x.ai"
    ? origin
    : undefined;
}

export async function startCallbackServer(
  port = Number(process.env.OPENCODE_XAI_OAUTH_PORT || XAI_OAUTH_REDIRECT_PORT)
) {
  let resolveCallback!: (result: CallbackResult) => void;
  const callbackPromise = new Promise<CallbackResult>(
    (resolve) => (resolveCallback = resolve)
  );
  let server: Server | undefined;

  await new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const origin = callbackCorsOrigin(req.headers.origin);
      const writeCors = () => {
        if (!origin) {
          return;
        }
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Vary", "Origin");
      };
      if (req.method === "OPTIONS") {
        writeCors();
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url || "/", `http://${XAI_OAUTH_REDIRECT_HOST}`);
      if (url.pathname !== XAI_OAUTH_REDIRECT_PATH) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      const result = {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
        error: url.searchParams.get("error") || undefined,
        error_description:
          url.searchParams.get("error_description") || undefined,
      };
      resolveCallback(result);
      writeCors();
      const hasError = Boolean(result.error);
      res.writeHead(hasError ? 400 : 200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(
        hasError
          ? HTML_ERROR(
              result.error_description || result.error || "Unknown error"
            )
          : HTML_SUCCESS
      );
    });
    server.once("error", reject);
    server.listen(port, XAI_OAUTH_REDIRECT_HOST, () => resolve());
  });

  return {
    redirectUri: `http://${XAI_OAUTH_REDIRECT_HOST}:${port}${XAI_OAUTH_REDIRECT_PATH}`,
    waitForCallback: (signal?: AbortSignal) =>
      new Promise<CallbackResult>((resolve, reject) => {
        const onAbort = () => reject(new Error("OAuth login aborted"));
        if (signal?.aborted) {
          return onAbort();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        callbackPromise
          .then(resolve, reject)
          .finally(() => signal?.removeEventListener("abort", onAbort));
      }),
    close: () => server?.close(),
  };
}

export async function exchangeCodeForToken(
  tokenEndpoint: string,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<StoredAuth> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: XAI_OAUTH_CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: authHeaders(),
    body,
  });
  if (!response.ok) {
    throw new Error(
      `xAI token exchange failed: ${response.status} ${await response.text()}`
    );
  }
  const token = (await response.json()) as TokenPayload;
  if (!(token.access_token && token.refresh_token)) {
    throw new Error("xAI token response did not include access/refresh tokens");
  }
  return {
    provider: "xai-oauth",
    access: token.access_token,
    refresh: token.refresh_token,
    expires: oauthExpiry(token.expires_in),
    tokenEndpoint,
    tokenType: token.token_type || "Bearer",
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  tokenEndpoint = XAI_OAUTH_TOKEN_URL
): Promise<TokenPayload & { access_token: string }> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: XAI_OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: authHeaders(),
    body,
  });
  if (!response.ok) {
    throw new Error(
      `xAI token refresh failed: ${response.status} ${await response.text()}`
    );
  }
  const token = (await response.json()) as TokenPayload;
  if (!token.access_token) {
    throw new Error("xAI refresh response did not include an access token");
  }
  return token as TokenPayload & { access_token: string };
}

export async function refreshStoredAuth(auth: StoredAuth): Promise<StoredAuth> {
  const token = await refreshAccessToken(auth.refresh, auth.tokenEndpoint);
  return {
    provider: "xai-oauth",
    access: token.access_token,
    refresh: token.refresh_token || auth.refresh,
    expires: oauthExpiry(token.expires_in),
    tokenEndpoint: auth.tokenEndpoint,
    tokenType: token.token_type || auth.tokenType || "Bearer",
  };
}

let refreshStoredAuthPromise: Promise<StoredAuth> | undefined;
let refreshStoredAuthKey: string | undefined;

function refreshStoredAuthSingleFlight(auth: StoredAuth, path = authPath()) {
  const key = `${path}:${auth.refresh}`;
  if (!refreshStoredAuthPromise || refreshStoredAuthKey !== key) {
    refreshStoredAuthKey = key;
    refreshStoredAuthPromise = refreshStoredAuth(auth)
      .then((refreshed) => {
        writeStoredAuth(refreshed, path);
        return refreshed;
      })
      .finally(() => {
        refreshStoredAuthPromise = undefined;
        refreshStoredAuthKey = undefined;
      });
  }
  return refreshStoredAuthPromise;
}

export async function requestDeviceCode(
  deviceAuthorizationEndpoint = XAI_OAUTH_DEVICE_AUTHORIZATION_URL
): Promise<DeviceCodeResponse> {
  const response = await fetch(deviceAuthorizationEndpoint, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `xAI device code request failed: ${response.status} ${await response.text()}`
    );
  }
  const json = (await response.json()) as DeviceCodeResponse;
  if (!(json.device_code && json.user_code && json.verification_uri)) {
    throw new Error(
      "xAI device code response is missing device_code / user_code / verification_uri"
    );
  }
  return json;
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function pollDeviceCodeToken(
  device: DeviceCodeResponse,
  options: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    tokenEndpoint?: string;
  } = {}
): Promise<TokenPayload> {
  const now = options.now || (() => Date.now());
  const wait = options.sleep || sleep;
  const expiresInMs = positiveSecondsToMs(
    device.expires_in,
    DEVICE_CODE_DEFAULT_EXPIRES_MS
  );
  const deadline = now() + expiresInMs;
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS
  );

  while (now() < deadline) {
    const response = await fetch(options.tokenEndpoint || XAI_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: device.device_code,
      }),
    });
    if (response.ok) {
      return (await response.json()) as TokenPayload;
    }

    const body = (await response
      .json()
      .catch(() => ({}))) as DeviceTokenErrorBody;
    const remaining = Math.max(0, deadline - now());
    if (body.error === "authorization_pending") {
      await wait(
        Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining)
      );
      continue;
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
      await wait(
        Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining)
      );
      continue;
    }
    if (
      body.error === "access_denied" ||
      body.error === "authorization_denied"
    ) {
      throw new Error("xAI device authorization was denied");
    }
    if (body.error === "expired_token") {
      throw new Error("xAI device code expired - please re-run login");
    }
    throw new Error(
      `xAI device token exchange failed: ${response.status} ${body.error_description || body.error || ""}`.trim()
    );
  }

  throw new Error("xAI device authorization timed out");
}

export async function resolveXaiCredentials(): Promise<XaiCredentials> {
  const stored = readStoredAuth();
  if (stored?.access) {
    let current = stored;
    const expiresSoon =
      stored.expires - Date.now() <= REFRESH_SKEW_MS ||
      accessTokenIsExpiring(stored.access);
    if (expiresSoon) {
      current = await refreshStoredAuthSingleFlight(stored);
    }
    return {
      provider: "xai-oauth",
      apiKey: current.access,
      baseUrl: process.env.XAI_BASE_URL || XAI_BASE_URL,
    };
  }
  const apiKey = (process.env.XAI_API_KEY || "").trim();
  if (apiKey) {
    return {
      provider: "xai",
      apiKey,
      baseUrl: process.env.XAI_BASE_URL || XAI_BASE_URL,
    };
  }
  throw new Error(
    "xAI credentials not found. Run `opencode-xai-oauth login` or set XAI_API_KEY."
  );
}

export async function beginOAuth() {
  const discovery = await discoverXaiOAuth();
  const callback = await startCallbackServer();
  const state = randomBytes(16).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const { verifier, challenge } = pkcePair();
  return {
    url: buildAuthorizeUrl({
      authorizationEndpoint:
        discovery.authorization_endpoint || XAI_OAUTH_AUTHORIZE_URL,
      challenge,
      nonce,
      redirectUri: callback.redirectUri,
      state,
    }),
    instructions:
      "브라우저에서 xAI/Grok 로그인을 완료하세요. 원격 환경이면 redirect URL 전체를 복사해 CLI에 붙여넣으세요.",
    async complete(signal?: AbortSignal) {
      try {
        const result = await callback.waitForCallback(signal);
        if (result.error) {
          throw new Error(result.error_description || result.error);
        }
        if (!result.code || result.state !== state) {
          throw new Error("Invalid xAI OAuth callback");
        }
        const auth = await exchangeCodeForToken(
          discovery.token_endpoint,
          result.code,
          verifier,
          callback.redirectUri
        );
        writeStoredAuth(auth);
        return auth;
      } finally {
        callback.close();
      }
    },
  };
}

export async function beginDeviceOAuth() {
  const discovery = await discoverXaiOAuth();
  const tokenEndpoint = discovery.token_endpoint || XAI_OAUTH_TOKEN_URL;
  const device = await requestDeviceCode(
    discovery.device_authorization_endpoint ||
      XAI_OAUTH_DEVICE_AUTHORIZATION_URL
  );
  return {
    url: device.verification_uri_complete || device.verification_uri,
    instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
    async complete() {
      const token = await pollDeviceCodeToken(device, { tokenEndpoint });
      if (!(token.access_token && token.refresh_token)) {
        throw new Error(
          "xAI token response did not include access/refresh tokens"
        );
      }
      const auth: StoredAuth = {
        provider: "xai-oauth",
        access: token.access_token,
        refresh: token.refresh_token,
        expires: oauthExpiry(token.expires_in),
        tokenEndpoint,
        tokenType: token.token_type || "Bearer",
      };
      writeStoredAuth(auth);
      return auth;
    },
  };
}

async function xaiFetch(path: string, init: RequestInit = {}) {
  const creds = await resolveXaiCredentials();
  const response = await fetch(
    `${creds.baseUrl.replace(TRAILING_SLASH_REGEX, "")}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "User-Agent": `opencode-xai-oauth/${PACKAGE_VERSION}`,
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...(init.headers || {}),
      },
    }
  );
  if (!response.ok) {
    throw new Error(
      `xAI request failed: ${response.status} ${await response.text()}`
    );
  }
  return response;
}

function outputMessages(payload: Record<string, unknown>) {
  const output = Array.isArray(payload.output) ? payload.output : [];
  return output.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item.type === "message" && Array.isArray(item.content)
  );
}

function responseText(payload: Record<string, unknown>) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  const parts: string[] = [];
  for (const item of outputMessages(payload)) {
    for (const content of item.content as unknown[]) {
      if (!isRecord(content)) {
        continue;
      }
      if (
        (content.type === "output_text" || content.type === "text") &&
        content.text
      ) {
        parts.push(String(content.text));
      }
    }
  }
  return parts.join("\n\n").trim();
}

function inlineCitations(payload: Record<string, unknown>) {
  const citations: Record<string, unknown>[] = [];
  for (const item of outputMessages(payload)) {
    for (const content of item.content as unknown[]) {
      if (!(isRecord(content) && Array.isArray(content.annotations))) {
        continue;
      }
      for (const annotation of content.annotations) {
        if (isRecord(annotation) && annotation.type === "url_citation") {
          citations.push(annotation);
        }
      }
    }
  }
  return citations;
}

export async function xaiResponses(input: {
  prompt: string;
  model?: string;
  tools?: Record<string, unknown>[];
  reasoningEffort?: "low" | "medium" | "high";
  timeoutMs?: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs || 180_000
  );
  try {
    const response = await xaiFetch("/responses", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model || "grok-4.3",
        input: [{ role: "user", content: input.prompt }],
        ...(input.tools?.length ? { tools: input.tools } : {}),
        ...(input.reasoningEffort
          ? { reasoning: { effort: input.reasoningEffort } }
          : {}),
        store: false,
      }),
    });
    const payload = await response.json();
    return {
      payload,
      text: responseText(payload),
      citations: payload.citations || [],
      inline_citations: inlineCitations(payload),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function xaiImageGenerate(args: {
  prompt: string;
  model?: string;
  n?: number;
  size?: string;
  resolution?: "1k" | "2k";
  response_format?: "url" | "b64_json";
}) {
  const body: Record<string, unknown> = {
    model: args.model || "grok-imagine-image",
    prompt: args.prompt,
    n: args.n || 1,
    response_format: args.response_format || "url",
  };
  if (args.resolution) {
    body.resolution = args.resolution;
  }
  if (args.size) {
    body.size = args.size;
  }
  const response = await xaiFetch("/images/generations", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return response.json();
}

export async function xaiTts(args: {
  input: string;
  voice?: string;
  voice_id?: string;
  language?: string;
  format?: string;
  codec?: string;
  sample_rate?: number;
  bit_rate?: number;
  text_normalization?: boolean;
}) {
  const codec = args.codec || args.format;
  const body: Record<string, unknown> = {
    text: args.input,
    voice_id: args.voice_id || args.voice || "eve",
    language: args.language || "auto",
  };
  if (codec || args.sample_rate || args.bit_rate) {
    body.output_format = {
      ...(codec ? { codec } : {}),
      ...(args.sample_rate ? { sample_rate: args.sample_rate } : {}),
      ...(args.bit_rate ? { bit_rate: args.bit_rate } : {}),
    };
  }
  if (typeof args.text_normalization === "boolean") {
    body.text_normalization = args.text_normalization;
  }

  const response = await xaiFetch("/tts", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    bytes,
    contentType:
      response.headers.get("content-type") || `audio/${codec || "mpeg"}`,
  };
}

export async function xaiVideoGenerate(
  args: {
    prompt: string;
    model?: string;
    duration?: number;
    aspect_ratio?: string;
    resolution?: "480p" | "720p";
    image_url?: string;
    reference_image_urls?: string[];
  },
  testOpts?: { pollIntervalMs?: number; maxWaitMs?: number }
) {
  const idempotencyKey = randomUUID();
  const body: Record<string, unknown> = {
    model: args.model || "grok-imagine-video",
    prompt: args.prompt,
    duration: typeof args.duration === "number" ? args.duration : 8,
    aspect_ratio: args.aspect_ratio || "16:9",
    resolution: args.resolution || "720p",
  };
  if (args.image_url) {
    body.image = { url: args.image_url };
  }
  if (args.reference_image_urls && args.reference_image_urls.length > 0) {
    body.reference_images = args.reference_image_urls.map((url) => ({ url }));
  }

  const submitRes = await xaiFetch("/videos/generations", {
    method: "POST",
    headers: { "x-idempotency-key": idempotencyKey },
    body: JSON.stringify(body),
  });
  const submitJson = (await submitRes.json()) as { request_id?: string };
  const requestId = submitJson.request_id;
  if (!requestId) {
    throw new Error("xAI video submit response did not include request_id");
  }

  const TIMEOUT_MS = testOpts?.maxWaitMs ?? 300_000; // 5 minutes
  const POLL_INTERVAL_MS = testOpts?.pollIntervalMs ?? 5000;
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    const pollRes = await xaiFetch(`/videos/${encodeURIComponent(requestId)}`, {
      method: "GET",
    });
    const data = (await pollRes.json()) as {
      status?: string;
      video?: { url?: string; duration?: number };
      error?: { message?: string };
      message?: string;
      model?: string;
    };
    const status = String(data.status || "").toLowerCase();

    if (status === "done") {
      return { request_id: requestId, ...data };
    }
    if (["failed", "expired", "error", "cancelled"].includes(status)) {
      const errMsg =
        data.error?.message || data.message || `ended with status ${status}`;
      throw new Error(`xAI video generation ${status}: ${errMsg}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `xAI video generation timed out after ${Math.floor(TIMEOUT_MS / 1000)}s (request_id=${requestId})`
  );
}
