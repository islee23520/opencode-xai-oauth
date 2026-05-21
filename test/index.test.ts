import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin as XaiOAuthPlugin } from "../src/index";
import { PACKAGE_VERSION } from "../src/version";
import {
  authPath,
  defaultAuthPath,
  legacyAuthPath,
  pkcePair,
  readStoredAuth,
  type StoredAuth,
  writeStoredAuth,
  xaiImageGenerate,
  xaiTts,
  xaiVideoGenerate,
} from "../src/xai";

function pluginCtx() {
  return { client: { app: { log: async () => undefined } } } as never;
}

function authFixture(overrides: Partial<StoredAuth> = {}): StoredAuth {
  return {
    provider: "xai-oauth",
    access: "a",
    refresh: "r",
    expires: 123,
    tokenEndpoint: "https://auth.x.ai/oauth2/token",
    tokenType: "Bearer",
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function useTempAuthFile(fileName = "auth.json") {
  const dir = mkdtempSync(join(tmpdir(), "opencode-xai-oauth-"));
  tempDirs.push(dir);
  process.env.OPENCODE_XAI_OAUTH_AUTH_FILE = join(dir, fileName);
  return dir;
}

async function applyChatHeaders(
  providerID: string,
  headers: Record<string, string> = {}
) {
  const plugin = await XaiOAuthPlugin(pluginCtx());
  const output = { headers } as { headers: Record<string, string> };
  await plugin["chat.headers"]?.(
    {
      model: {
        providerID,
        modelID: providerID === "xai" ? "grok-4.3" : "gpt-test",
      },
      provider: { id: providerID },
      message: {},
    } as never,
    output as never
  );
  return output.headers;
}

async function applyShellEnv(env: Record<string, string> = {}) {
  const plugin = await XaiOAuthPlugin(pluginCtx());
  await plugin["shell.env"]?.({} as never, { env } as never);
  return env;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
  delete process.env.OPENCODE_XAI_OAUTH_AUTH_FILE;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XAI_API_KEY;
  delete process.env.XAI_BASE_URL;
  globalThis.fetch = originalFetch;
});

describe("XaiOAuthPlugin", () => {
  test("keeps source package version in sync with package metadata", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      version: string;
    };

    expect(PACKAGE_VERSION).toBe(packageJson.version);
  });

  test("exports OpenCode auth/provider/tools hooks", async () => {
    const plugin = await XaiOAuthPlugin(pluginCtx());

    expect(typeof XaiOAuthPlugin).toBe("function");
    expect(plugin.auth?.provider).toBe("xai");
    expect(plugin.provider).toBeUndefined();
    expect(typeof plugin.config).toBe("function");
    expect(typeof plugin["chat.params"]).toBe("function");
    expect(Object.keys(plugin.tool || {}).sort()).toEqual([
      "xai_generate_text",
      "xai_image_generate",
      "xai_status",
      "xai_tts",
      "xai_video_generate",
      "xai_web_search",
      "xai_x_search",
    ]);
  });

  test("adds Grok thinking metadata to the built-in xAI provider config", async () => {
    const plugin = await XaiOAuthPlugin(pluginCtx());
    const config = {} as Record<string, unknown>;

    await plugin.config?.(config as never);

    const provider = config.provider as Record<
      string,
      { models: Record<string, Record<string, unknown>> }
    >;
    const grok43 = provider.xai.models["grok-4.3"];
    const grok43Variants = grok43.variants as Record<
      string,
      { reasoningEffort: string }
    >;

    expect(grok43.reasoning).toBe(true);
    expect(grok43Variants.high.reasoningEffort).toBe("high");
    expect(grok43Variants.xhigh).toBeUndefined();
    expect(grok43Variants.max).toBeUndefined();
    expect(provider.xai.models["grok-4.20-reasoning"].reasoning).toBe(true);
  });

  test("adds xAI skill-like OpenCode commands without overwriting user commands", async () => {
    const plugin = await XaiOAuthPlugin(pluginCtx());
    const config = {
      command: { "xai-web-search": { template: "custom" } },
    } as Record<string, unknown>;

    await plugin.config?.(config as never);

    const commands = config.command as Record<
      string,
      { template: string; description?: string }
    >;
    expect(commands["xai-web-search"].template).toBe("custom");
    expect(commands["xai-x-search"].template).toContain("xai_x_search");
    expect(commands["xai-image"].template).toContain("xai_image_generate");
    expect(commands["xai-tts"].template).toContain("xai_tts");
    expect(commands["xai-video"].template).toContain("xai_video_generate");
    expect(commands["xai-status"].template).toContain("xai_status");
  });

  test("maps supported xAI Grok 4.3 variants to reasoning effort request options", async () => {
    const plugin = await XaiOAuthPlugin(pluginCtx());
    const output = { options: {} } as { options: Record<string, unknown> };

    await plugin["chat.params"]?.(
      {
        model: { providerID: "xai", modelID: "grok-4.3" },
        provider: { id: "xai" },
        message: { variant: "high" },
      } as never,
      output as never
    );

    expect(output.options.reasoningEffort).toBe("high");
    expect(output.options.reasoning_effort).toBe("high");
  });

  test("does not map unsupported Grok 4.3 variants to request options", async () => {
    const plugin = await XaiOAuthPlugin(pluginCtx());
    const output = { options: {} } as { options: Record<string, unknown> };

    await plugin["chat.params"]?.(
      {
        model: { providerID: "xai", modelID: "grok-4.3" },
        provider: { id: "xai" },
        message: { variant: "max" },
      } as never,
      output as never
    );

    expect(output.options.reasoningEffort).toBeUndefined();
    expect(output.options.reasoning_effort).toBeUndefined();
  });

  test("does not send unsupported reasoning_effort to Grok 4.20 reasoning", async () => {
    const plugin = await XaiOAuthPlugin(pluginCtx());
    const output = { options: {} } as { options: Record<string, unknown> };

    await plugin["chat.params"]?.(
      {
        model: { providerID: "xai", modelID: "grok-4.20-reasoning" },
        provider: { id: "xai" },
        message: { variant: "high" },
      } as never,
      output as never
    );

    expect(output.options.reasoningEffort).toBeUndefined();
    expect(output.options.reasoning_effort).toBeUndefined();
  });

  test("status tool reports missing credentials without throwing", async () => {
    useTempAuthFile();
    delete process.env.XAI_API_KEY;
    const plugin = await XaiOAuthPlugin(pluginCtx());
    const result = await plugin.tool?.xai_status.execute({}, {
      directory: process.cwd(),
      worktree: process.cwd(),
    } as never);
    expect(String(result)).toContain("credentials not found");
  });

  test("auth loader refreshes expired OAuth file instead of returning stale OpenCode access token", async () => {
    useTempAuthFile();
    writeStoredAuth(
      authFixture({
        access: "stale-file-access",
        refresh: "refresh-token",
        expires: Date.now() - 1000,
      })
    );

    let refreshBody = "";
    globalThis.fetch = ((
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      refreshBody = String(init?.body || "");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "fresh-access",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    }) as unknown as typeof fetch;

    const plugin = await XaiOAuthPlugin(pluginCtx());
    const loaded = await plugin.auth?.loader?.(
      async () => ({
        type: "oauth",
        access: "stale-opencode-access",
        refresh: "refresh-token",
        expires: Date.now() - 1000,
      }),
      {} as never
    );

    expect(refreshBody).toContain("grant_type=refresh_token");
    if (!loaded) {
      throw new Error("expected auth loader result");
    }
    expect(loaded.apiKey).toBe("fresh-access");
    expect(readStoredAuth()?.access).toBe("fresh-access");
  });

  test("chat headers reload expired OAuth credentials at runtime", async () => {
    useTempAuthFile();
    writeStoredAuth(
      authFixture({
        access: "expired-chat-access",
        refresh: "runtime-refresh-token",
        expires: Date.now() - 1000,
      })
    );

    const refreshBodies: string[] = [];
    globalThis.fetch = ((
      _url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      refreshBodies.push(String(init?.body || ""));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "fresh-chat-access",
            refresh_token: "rotated-runtime-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    }) as unknown as typeof fetch;

    const headers = await applyChatHeaders("xai", { "x-existing": "kept" });

    expect(refreshBodies).toHaveLength(1);
    expect(refreshBodies[0]).toContain("grant_type=refresh_token");
    expect(headers.Authorization).toBe("Bearer fresh-chat-access");
    expect(headers["x-existing"]).toBe("kept");
    expect(readStoredAuth()?.access).toBe("fresh-chat-access");
    expect(readStoredAuth()?.refresh).toBe("rotated-runtime-refresh-token");
  });

  test("chat headers do not break OpenCode-managed auth when no reloadable credentials exist", async () => {
    useTempAuthFile("missing-auth.json");
    delete process.env.XAI_API_KEY;
    const headers = await applyChatHeaders("xai", {
      Authorization: "Bearer opencode-managed-token",
    });

    expect(headers.Authorization).toBe("Bearer opencode-managed-token");
  });

  test("chat headers can use API-key credentials at runtime", async () => {
    useTempAuthFile("missing-auth.json");
    process.env.XAI_API_KEY = "xai-runtime-api-key";

    const headers = await applyChatHeaders("xai");

    expect(headers.Authorization).toBe("Bearer xai-runtime-api-key");
  });

  test("chat headers fail closed when expired OAuth refresh fails at runtime", async () => {
    useTempAuthFile();
    writeStoredAuth(
      authFixture({
        access: "expired-chat-access",
        refresh: "bad-runtime-refresh-token",
        expires: Date.now() - 1000,
      })
    );
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("invalid refresh", { status: 401 })
      )) as unknown as typeof fetch;

    const output = {
      headers: { Authorization: "Bearer stale-runtime-token" },
    } as {
      headers: Record<string, string>;
    };

    await expect(applyChatHeaders("xai", output.headers)).rejects.toThrow(
      "xAI token refresh failed"
    );
    expect(output.headers.Authorization).toBe("Bearer stale-runtime-token");
  });

  test("chat headers do not touch non-xAI providers", async () => {
    let fetchCalled = false;
    globalThis.fetch = (() => {
      fetchCalled = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const headers = await applyChatHeaders("openai");

    expect(fetchCalled).toBe(false);
    expect(headers.Authorization).toBeUndefined();
  });

  test("shell env preserves OpenCode shell env when no plugin-managed credentials exist", async () => {
    useTempAuthFile("missing-auth.json");

    const env = await applyShellEnv({ EXISTING: "kept" });

    expect(env.EXISTING).toBe("kept");
    expect(env.XAI_API_KEY).toBeUndefined();
    expect(env.XAI_BASE_URL).toBeUndefined();
  });

  test("shell env fail closes when expired OAuth refresh fails", async () => {
    useTempAuthFile();
    writeStoredAuth(
      authFixture({
        access: "expired-shell-access",
        refresh: "bad-shell-refresh-token",
        expires: Date.now() - 1000,
      })
    );
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("invalid refresh", { status: 401 })
      )) as unknown as typeof fetch;

    await expect(applyShellEnv()).rejects.toThrow("xAI token refresh failed");
  });
});

describe("xAI auth helpers", () => {
  test("generates PKCE verifier and challenge", () => {
    const pair = pkcePair();
    expect(pair.verifier.length).toBeGreaterThan(20);
    expect(pair.challenge.length).toBeGreaterThan(20);
    expect(pair.verifier).not.toBe(pair.challenge);
  });

  test("stores auth file with restricted JSON payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-xai-oauth-"));
    process.env.OPENCODE_XAI_OAUTH_AUTH_FILE = join(dir, "auth.json");
    writeStoredAuth(authFixture());
    expect(authPath()).toBe(join(dir, "auth.json"));
    expect(existsSync(authPath())).toBe(true);
    expect(readStoredAuth()?.access).toBe("a");
    expect(readFileSync(authPath(), "utf8")).toContain("xai-oauth");
    rmSync(dir, { recursive: true, force: true });
  });

  test("defaults OAuth storage under the OpenCode config directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-xai-oauth-"));
    process.env.XDG_CONFIG_HOME = dir;

    expect(authPath()).toBe(join(dir, "opencode", "xai-oauth", "auth.json"));
    writeStoredAuth(authFixture());

    expect(existsSync(defaultAuthPath())).toBe(true);
    expect(readStoredAuth()?.access).toBe("a");
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads legacy auth file when the new OpenCode config auth file is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-xai-oauth-"));
    process.env.XDG_CONFIG_HOME = dir;

    writeStoredAuth(authFixture({ access: "legacy" }), legacyAuthPath());

    expect(defaultAuthPath()).toBe(
      join(dir, "opencode", "xai-oauth", "auth.json")
    );
    expect(readStoredAuth()?.access).toBe("legacy");
    rmSync(dir, { recursive: true, force: true });
  });

  test("ignores corrupt stored auth instead of crashing status checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-xai-oauth-"));
    process.env.OPENCODE_XAI_OAUTH_AUTH_FILE = join(dir, "auth.json");
    writeFileSync(authPath(), "{not-json");
    expect(readStoredAuth()).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses current xAI image generation defaults and resolution", async () => {
    process.env.XAI_API_KEY = "xai-test";
    let requestUrl = "";
    let requestBody = {} as Record<string, unknown>;
    let requestHeaders = {} as Record<string, string>;
    globalThis.fetch = ((
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      requestHeaders = (init?.headers as Record<string, string>) || {};
      return Promise.resolve(
        new Response(
          JSON.stringify({ data: [{ url: "https://example.test/image.jpg" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    }) as unknown as typeof fetch;

    await xaiImageGenerate({ prompt: "tiny test image", resolution: "1k" });

    expect(requestUrl).toBe("https://api.x.ai/v1/images/generations");
    expect(requestBody.model).toBe("grok-imagine-image");
    expect(requestBody.prompt).toBe("tiny test image");
    expect(requestBody.resolution).toBe("1k");
    expect(requestBody.size).toBeUndefined();
    expect(requestHeaders["User-Agent"]).toBe(
      `opencode-xai-oauth/${PACKAGE_VERSION}`
    );
  });

  test("uses current xAI TTS endpoint and payload", async () => {
    process.env.XAI_API_KEY = "xai-test";
    let requestUrl = "";
    let requestBody = {} as Record<string, unknown>;
    globalThis.fetch = ((
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      requestUrl = String(url);
      requestBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        })
      );
    }) as unknown as typeof fetch;

    const result = await xaiTts({
      input: "hello",
      voice_id: "eve",
      language: "en",
      codec: "mp3",
      sample_rate: 24_000,
    });

    expect(requestUrl).toBe("https://api.x.ai/v1/tts");
    expect(requestBody.text).toBe("hello");
    expect(requestBody.voice_id).toBe("eve");
    expect(requestBody.language).toBe("en");
    expect(requestBody.output_format).toEqual({
      codec: "mp3",
      sample_rate: 24_000,
    });
    expect(result.bytes.length).toBe(3);
  });

  test("uses current xAI video generation defaults, supports image_url for i2v, and polls to completion", async () => {
    process.env.XAI_API_KEY = "xai-test";
    const calls: Array<{
      url: string;
      method: string;
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    }> = [];
    let pollCount = 0;

    globalThis.fetch = ((
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const u = String(url);
      const method = String(init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const headers = (init?.headers as Record<string, string>) || {};
      calls.push({ url: u, method, body, headers });

      if (u.includes("/videos/generations") && method === "POST") {
        // First submit returns request_id
        return Promise.resolve(
          new Response(JSON.stringify({ request_id: "vid-test-123" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      }

      if (u.includes("/videos/vid-test-123") && method === "GET") {
        pollCount++;
        if (pollCount === 1) {
          // First poll returns pending → one very short sleep in test
          return Promise.resolve(
            new Response(JSON.stringify({ status: "pending" }), {
              status: 200,
            })
          );
        }
        // Second poll succeeds
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "done",
              model: "grok-imagine-video",
              video: { url: "https://vidgen.x.ai/test-video.mp4", duration: 8 },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      }

      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;

    const result = await xaiVideoGenerate(
      {
        prompt: "a cat jumping over a fence",
        duration: 6,
        aspect_ratio: "16:9",
        resolution: "720p",
        image_url: "https://example.com/start-frame.jpg",
      },
      { pollIntervalMs: 1, maxWaitMs: 2000 }
    );

    // First call: POST to generations with correct payload + idempotency key
    const submitCall = calls.find(
      (c) => c.url.includes("/videos/generations") && c.method === "POST"
    );
    expect(submitCall).toBeTruthy();
    expect(submitCall?.url).toBe("https://api.x.ai/v1/videos/generations");
    expect(submitCall?.body?.model).toBe("grok-imagine-video");
    expect(submitCall?.body?.prompt).toBe("a cat jumping over a fence");
    expect(submitCall?.body?.duration).toBe(6);
    expect(submitCall?.body?.aspect_ratio).toBe("16:9");
    expect(submitCall?.body?.resolution).toBe("720p");
    expect(submitCall?.body?.image).toEqual({
      url: "https://example.com/start-frame.jpg",
    });
    expect(submitCall?.headers?.["x-idempotency-key"]).toBeTruthy();

    // Subsequent calls: polling GETs
    const pollCalls = calls.filter((c) =>
      c.url.includes("/videos/vid-test-123")
    );
    expect(pollCalls.length).toBeGreaterThanOrEqual(2);
    expect(pollCalls[0].method).toBe("GET");

    // Final result shape
    expect(result.status).toBe("done");
    expect(result.video?.url).toBe("https://vidgen.x.ai/test-video.mp4");
    expect(result.model).toBe("grok-imagine-video");
  });
});
