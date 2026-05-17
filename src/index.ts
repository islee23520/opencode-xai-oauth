import type { Config, Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import {
  beginOAuth,
  downloadMediaToArtifacts,
  readStoredAuth,
  resolveXaiCredentials,
  saveBase64Image,
  XAI_BASE_URL,
  xaiImageGenerate,
  xaiResponses,
  xaiTts,
  xaiVideoGenerate,
} from "./xai";

const MAX_HANDLES = 10;
const GROK_REASONING_EFFORTS = ["low", "medium", "high"] as const;

type GrokReasoningEffort = (typeof GROK_REASONING_EFFORTS)[number];

type MutableConfig = Config & {
  provider?: Record<
    string,
    {
      models?: Record<string, Record<string, unknown>>;
      options?: Record<string, unknown>;
    }
  >;
  command?: Record<
    string,
    {
      template: string;
      description?: string;
      agent?: string;
      model?: string;
      subtask?: boolean;
    }
  >;
};

function handles(input?: string[]) {
  const cleaned = (input || [])
    .map((h) =>
      String(h || "")
        .trim()
        .replace(/^@+/, "")
    )
    .filter(Boolean);
  if (cleaned.length > MAX_HANDLES) {
    throw new Error(`supports at most ${MAX_HANDLES} handles`);
  }
  return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGrokModel(modelID: string | undefined) {
  return typeof modelID === "string" && modelID.toLowerCase().includes("grok");
}

function normalizeGrokReasoningEffort(
  value: unknown
): GrokReasoningEffort | undefined {
  if (typeof value !== "string") {
    return;
  }
  const normalized = value.toLowerCase();
  return GROK_REASONING_EFFORTS.includes(normalized as GrokReasoningEffort)
    ? (normalized as GrokReasoningEffort)
    : undefined;
}

function grokReasoningVariantOptions() {
  return Object.fromEntries(
    GROK_REASONING_EFFORTS.map((variant) => [
      variant,
      { reasoningEffort: variant },
    ])
  ) as Record<GrokReasoningEffort, { reasoningEffort: GrokReasoningEffort }>;
}

function applyGrokThinkingConfig(config: MutableConfig) {
  config.provider ??= {};
  const xai = (config.provider.xai ??= {});
  xai.models ??= {};

  const upsertModel = (modelID: string, model: Record<string, unknown>) => {
    const current = xai.models?.[modelID] || {};
    xai.models![modelID] = {
      ...current,
      ...model,
      variants: {
        ...(isRecord(current.variants) ? current.variants : {}),
        ...grokReasoningVariantOptions(),
      },
      options: {
        ...(isRecord(current.options) ? current.options : {}),
        ...(isRecord(model.options) ? model.options : {}),
      },
    };
  };

  upsertModel("grok-4.3", {
    name: "Grok 4.3",
    family: "grok",
    reasoning: true,
    temperature: true,
    tool_call: true,
    attachment: true,
    limit: { context: 1_000_000, output: 131_072 },
    modalities: { input: ["text", "image"], output: ["text"] },
    options: { reasoningEffort: "low" },
  });

  upsertModel("grok-4.20-reasoning", {
    name: "Grok 4.20 Reasoning",
    family: "grok",
    reasoning: true,
    temperature: true,
    tool_call: true,
    attachment: true,
    limit: { context: 1_000_000, output: 131_072 },
    modalities: { input: ["text", "image"], output: ["text"] },
  });
}

function applyXaiSkillCommands(config: MutableConfig) {
  config.command ??= {};
  const commands: NonNullable<MutableConfig["command"]> = {
    "xai-status": {
      description: "Check xAI OAuth/API-key credential status",
      template:
        "Use the `xai_status` tool and summarize whether xAI credentials are available. Do not expose tokens or secrets.",
    },
    "xai-text": {
      description: "Generate text with xAI Grok",
      template:
        "Use the `xai_generate_text` tool for this request: $ARGUMENTS\n\nIf no model is specified, use the tool default. If the user asks for thinking effort, pass `reasoning_effort` as `low`, `medium`, or `high`.",
    },
    "xai-web-search": {
      description: "Search the web with xAI/Grok native web_search",
      template:
        "Use the `xai_web_search` tool to answer this web-search request: $ARGUMENTS\n\nReturn a concise answer and include citations from the tool output when available.",
    },
    "xai-x-search": {
      description: "Search X/Twitter with xAI/Grok native x_search",
      template:
        "Use the `xai_x_search` tool to answer this X/Twitter search request: $ARGUMENTS\n\nIf the user provides @handles, pass them as `allowed_x_handles` unless they explicitly ask to exclude them. Return a concise answer and include citations from the tool output when available.",
    },
    "xai-image": {
      description:
        "Generate an image with xAI Grok Imagine (shown as popup in OpenCode via OpenTUI)",
      template:
        "Use the `xai_image_generate` tool to generate an image for this prompt: $ARGUMENTS\n\nThe image will be saved locally under .opencode/artifacts/ and displayed as a rich popup/preview in the OpenCode terminal (OpenTUI).",
    },
    "xai-tts": {
      description: "Generate speech audio with xAI Text to Speech",
      template:
        "Use the `xai_tts` tool to synthesize this text: $ARGUMENTS\n\nDefault to `voice_id: eve`, `language: auto`, and `codec: mp3` unless the user asks otherwise. Return the content type and explain that the audio is base64 in the tool output.",
    },
    "xai-video": {
      description:
        "Generate a video with xAI Grok Imagine Video (shown as popup in OpenCode via OpenTUI)",
      template:
        "Use the `xai_video_generate` tool to generate a video for this prompt: $ARGUMENTS\n\nSupports `image_url` (image-to-video) and `reference_image_urls` (array of up to 7 style/character references). The video is saved locally under .opencode/artifacts/ and shown in an OpenTUI media popup. Defaults: 8s, 16:9, 720p.",
    },
  };

  for (const [name, command] of Object.entries(commands)) {
    config.command[name] ??= command;
  }
}

function inputModelID(input: unknown): string | undefined {
  if (!(isRecord(input) && isRecord(input.model))) {
    return;
  }
  return typeof input.model.modelID === "string"
    ? input.model.modelID
    : typeof input.model.id === "string"
      ? input.model.id
      : undefined;
}

function inputProviderID(input: unknown): string | undefined {
  if (!isRecord(input)) {
    return;
  }
  if (isRecord(input.model) && typeof input.model.providerID === "string") {
    return input.model.providerID;
  }
  if (isRecord(input.provider) && typeof input.provider.id === "string") {
    return input.provider.id;
  }
  return;
}

function inputVariant(input: unknown): string | undefined {
  if (!(isRecord(input) && isRecord(input.message))) {
    return;
  }
  return typeof input.message.variant === "string"
    ? input.message.variant
    : undefined;
}

function applyGrokReasoningParams(input: unknown, output: unknown) {
  if (!isRecord(output)) {
    return;
  }
  if (inputProviderID(input) !== "xai") {
    return;
  }
  const modelID = inputModelID(input);
  if (!isGrokModel(modelID)) {
    return;
  }
  if (modelID !== "grok-4.3") {
    return;
  }

  const options = isRecord(output.options) ? output.options : {};
  output.options = options;
  const effort =
    normalizeGrokReasoningEffort(options.reasoningEffort) ??
    normalizeGrokReasoningEffort(inputVariant(input));
  if (!effort) {
    return;
  }

  options.reasoningEffort = effort;
  options.reasoning_effort = effort;
}

export const plugin: Plugin = async (ctx) => {
  return {
    auth: {
      provider: "xai",
      loader: async (auth) => {
        const current = await auth();
        if (current.type === "oauth") {
          return { apiKey: current.access, baseURL: XAI_BASE_URL };
        }
        if (current.type === "api") {
          return {
            apiKey: current.key,
            baseURL: current.metadata?.baseURL || XAI_BASE_URL,
          };
        }
        return {};
      },
      methods: [
        {
          type: "oauth",
          label: "xAI OAuth (Grok / SuperGrok)",
          async authorize() {
            const flow = await beginOAuth();
            return {
              method: "auto",
              url: flow.url,
              instructions: flow.instructions,
              async callback() {
                try {
                  const auth = await flow.complete();
                  return {
                    type: "success",
                    provider: "xai",
                    refresh: auth.refresh,
                    access: auth.access,
                    expires: auth.expires,
                  };
                } catch {
                  return { type: "failed" };
                }
              },
            };
          },
        },
        {
          type: "api",
          label: "xAI API key",
          prompts: [
            {
              type: "text",
              key: "apiKey",
              message: "xAI API key",
              placeholder: "xai-...",
            },
          ],
          async authorize(inputs) {
            const key = String(inputs?.apiKey || "").trim();
            return key
              ? {
                  type: "success",
                  provider: "xai",
                  key,
                  metadata: { baseURL: XAI_BASE_URL },
                }
              : { type: "failed" };
          },
        },
      ],
    },
    config: async (config) => {
      applyGrokThinkingConfig(config as MutableConfig);
      applyXaiSkillCommands(config as MutableConfig);
    },
    "chat.params": async (input, output) => {
      applyGrokReasoningParams(input, output);
    },
    tool: {
      xai_status: tool({
        description:
          "Show whether xAI OAuth/API-key credentials are available for this OpenCode plugin.",
        args: {},
        async execute() {
          const stored = readStoredAuth();
          try {
            const creds = await resolveXaiCredentials();
            return JSON.stringify(
              {
                success: true,
                credential_source: creds.provider,
                base_url: creds.baseUrl,
                oauth_file_present: Boolean(stored),
              },
              null,
              2
            );
          } catch (error) {
            return JSON.stringify(
              {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                oauth_file_present: Boolean(stored),
              },
              null,
              2
            );
          }
        },
      }),
      xai_generate_text: tool({
        description: "Generate text with xAI Grok through the Responses API.",
        args: {
          prompt: tool.schema.string(),
          model: tool.schema.string().optional(),
          reasoning_effort: tool.schema
            .enum(["low", "medium", "high"])
            .optional(),
        },
        async execute(args) {
          const result = await xaiResponses({
            prompt: args.prompt,
            model: args.model,
            reasoningEffort: args.reasoning_effort,
          });
          return {
            title: "xAI text",
            output: JSON.stringify(
              {
                success: true,
                answer: result.text,
                citations: result.citations,
                inline_citations: result.inline_citations,
              },
              null,
              2
            ),
          };
        },
      }),
      xai_x_search: tool({
        description:
          "Search X/Twitter posts, profiles, and threads using xAI's server-side x_search Responses API tool.",
        args: {
          query: tool.schema.string(),
          allowed_x_handles: tool.schema.array(tool.schema.string()).optional(),
          excluded_x_handles: tool.schema
            .array(tool.schema.string())
            .optional(),
          from_date: tool.schema.string().optional(),
          to_date: tool.schema.string().optional(),
          enable_image_understanding: tool.schema.boolean().optional(),
          enable_video_understanding: tool.schema.boolean().optional(),
          model: tool.schema.string().optional(),
        },
        async execute(args) {
          const allowed = handles(args.allowed_x_handles);
          const excluded = handles(args.excluded_x_handles);
          if (allowed.length && excluded.length) {
            throw new Error(
              "allowed_x_handles and excluded_x_handles cannot be used together"
            );
          }
          const toolDef: Record<string, unknown> = { type: "x_search" };
          if (allowed.length) {
            toolDef.allowed_x_handles = allowed;
          }
          if (excluded.length) {
            toolDef.excluded_x_handles = excluded;
          }
          if (args.from_date) {
            toolDef.from_date = args.from_date;
          }
          if (args.to_date) {
            toolDef.to_date = args.to_date;
          }
          if (args.enable_image_understanding) {
            toolDef.enable_image_understanding = true;
          }
          if (args.enable_video_understanding) {
            toolDef.enable_video_understanding = true;
          }
          const result = await xaiResponses({
            prompt: args.query,
            model: args.model || "grok-4.3",
            tools: [toolDef],
          });
          return JSON.stringify(
            {
              success: true,
              tool: "x_search",
              query: args.query,
              answer: result.text,
              citations: result.citations,
              inline_citations: result.inline_citations,
            },
            null,
            2
          );
        },
      }),
      xai_web_search: tool({
        description:
          "Search the web using xAI/Grok native server-side web search through the Responses API.",
        args: {
          query: tool.schema.string(),
          model: tool.schema.string().optional(),
        },
        async execute(args) {
          const result = await xaiResponses({
            prompt: args.query,
            model: args.model || "grok-4.3",
            tools: [{ type: "web_search" }],
          });
          return JSON.stringify(
            {
              success: true,
              tool: "web_search",
              query: args.query,
              answer: result.text,
              citations: result.citations,
              inline_citations: result.inline_citations,
            },
            null,
            2
          );
        },
      }),
      xai_image_generate: tool({
        description:
          "Generate images with xAI's image generation endpoint. Returns upstream JSON, usually URLs or base64 payloads.",
        args: {
          prompt: tool.schema.string(),
          model: tool.schema.string().optional(),
          n: tool.schema.number().int().min(1).max(4).optional(),
          size: tool.schema.string().optional(),
          resolution: tool.schema.enum(["1k", "2k"]).optional(),
          response_format: tool.schema.enum(["url", "b64_json"]).optional(),
        },
        async execute(args, context) {
          const data = await xaiImageGenerate(args);
          const result: any = { success: true, ...data };

          const images = data?.data || [];
          if (images.length > 0) {
            const attachments: any[] = [];

            for (let i = 0; i < images.length; i++) {
              const img = images[i];
              const timestamp = Date.now() + (i > 0 ? i : 0);
              const mime = img.mime_type || "image/png";
              const ext =
                mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";

              let attachmentUrl: string | null = null;
              const filename = `grok-image-${i + 1}.${ext}`;

              if (img.b64_json) {
                try {
                  const localPath = await saveBase64Image(
                    img.b64_json,
                    `grok-image-${timestamp}.${ext}`,
                    context.worktree
                  );
                  attachmentUrl = localPath;
                } catch (e) {
                  console.error("Failed to save base64 image locally:", e);
                }
              } else if (img.url) {
                try {
                  const localPath = await downloadMediaToArtifacts(
                    img.url,
                    `grok-image-${timestamp}.${ext}`,
                    context.worktree
                  );
                  attachmentUrl = localPath;
                } catch (e) {
                  console.error(
                    "Local download failed for image, using remote URL for attachment:",
                    e
                  );
                  attachmentUrl = img.url; // Fallback so OpenTUI can still show the popup
                }
              }

              if (attachmentUrl) {
                attachments.push({
                  type: "file",
                  mime,
                  url: attachmentUrl,
                  filename,
                });
              }
            }

            if (attachments.length > 0) {
              return {
                title:
                  images.length === 1
                    ? "xAI Image"
                    : `xAI Images (${images.length})`,
                output: JSON.stringify(result, null, 2),
                attachments,
              };
            }
          }

          return JSON.stringify(result, null, 2);
        },
      }),
      xai_tts: tool({
        description:
          "Generate speech audio with xAI's Text to Speech endpoint. Returns base64 audio for saving by the caller.",
        args: {
          input: tool.schema.string(),
          voice: tool.schema.string().optional(),
          voice_id: tool.schema.string().optional(),
          language: tool.schema.string().optional(),
          format: tool.schema.string().optional(),
          codec: tool.schema.string().optional(),
          sample_rate: tool.schema.number().int().optional(),
          bit_rate: tool.schema.number().int().optional(),
          text_normalization: tool.schema.boolean().optional(),
        },
        async execute(args) {
          const result = await xaiTts(args);
          return {
            title: "xAI TTS",
            output: JSON.stringify({
              success: true,
              content_type: result.contentType,
              audio_base64: result.bytes.toString("base64"),
            }),
          };
        },
      }),
      xai_video_generate: tool({
        description:
          "Generate videos with xAI Grok Imagine (grok-imagine-video). Supports text-to-video, image-to-video (image_url), and reference images (reference_image_urls, up to 7). Media is saved locally and attached for OpenTUI popup display in OpenCode.",
        args: {
          prompt: tool.schema.string(),
          model: tool.schema.string().optional(),
          duration: tool.schema.number().int().min(1).max(15).optional(),
          aspect_ratio: tool.schema.string().optional(),
          resolution: tool.schema.enum(["480p", "720p"]).optional(),
          image_url: tool.schema.string().optional(),
          reference_image_urls: tool.schema
            .array(tool.schema.string())
            .optional(),
        },
        async execute(args, context) {
          const data = await xaiVideoGenerate(args as any);
          const result: any = { success: true, ...data };

          // Attach the generated video so OpenCode (OpenTUI) can show it in a nice popup/media player.
          // Download locally under .opencode/artifacts/ for a stable file after generation.
          const videoUrl = data?.video?.url;
          if (videoUrl) {
            try {
              const localPath = await downloadMediaToArtifacts(
                videoUrl,
                `grok-video-${Date.now()}.mp4`,
                context.worktree
              );
              return {
                title: "xAI Video",
                output: JSON.stringify(result, null, 2),
                attachments: [
                  {
                    type: "file",
                    mime: "video/mp4",
                    url: localPath,
                    filename: "grok-video.mp4",
                  },
                ],
              };
            } catch {
              // fallback to remote URL
            }
          }
          return JSON.stringify(result, null, 2);
        },
      }),
    },
    "shell.env": async (_input, output) => {
      try {
        const creds = await resolveXaiCredentials();
        output.env.XAI_API_KEY = creds.apiKey;
        output.env.XAI_BASE_URL = creds.baseUrl;
      } catch {
        // No credentials yet; keep shell unchanged.
      }
    },
    event: async ({ event }) => {
      if (event.type === "server.connected") {
        await ctx.client.app
          .log({
            body: {
              service: "opencode-xai-oauth",
              level: "info",
              message: "xAI OAuth plugin loaded",
            },
          })
          .catch(() => {});
      }
    },
  };
};

export default plugin;
