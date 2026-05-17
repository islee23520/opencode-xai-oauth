import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { beginOAuth, readStoredAuth, resolveXaiCredentials, xaiImageGenerate, xaiResponses, xaiTts, XAI_BASE_URL } from "./xai"

const MAX_HANDLES = 10

function handles(input?: string[]) {
  const cleaned = (input || []).map((h) => String(h || "").trim().replace(/^@+/, "")).filter(Boolean)
  if (cleaned.length > MAX_HANDLES) throw new Error(`supports at most ${MAX_HANDLES} handles`)
  return cleaned
}

export const XaiOAuthPlugin: Plugin = async (ctx) => {
  return {
    auth: {
      provider: "xai",
      loader: async (auth) => {
        const current = await auth()
        if (current.type === "oauth") return { apiKey: current.access, baseURL: XAI_BASE_URL }
        if (current.type === "api") return { apiKey: current.key, baseURL: current.metadata?.baseURL || XAI_BASE_URL }
        return {}
      },
      methods: [
        {
          type: "oauth",
          label: "xAI OAuth (Grok / SuperGrok)",
          async authorize() {
            const flow = await beginOAuth()
            return {
              method: "auto",
              url: flow.url,
              instructions: flow.instructions,
              async callback() {
                try {
                  const auth = await flow.complete()
                  return { type: "success", provider: "xai", refresh: auth.refresh, access: auth.access, expires: auth.expires }
                } catch {
                  return { type: "failed" }
                }
              },
            }
          },
        },
        {
          type: "api",
          label: "xAI API key",
          prompts: [{ type: "text", key: "apiKey", message: "xAI API key", placeholder: "xai-..." }],
          async authorize(inputs) {
            const key = String(inputs?.apiKey || "").trim()
            return key ? { type: "success", provider: "xai", key, metadata: { baseURL: XAI_BASE_URL } } : { type: "failed" }
          },
        },
      ],
    },
    // Do not override OpenCode's built-in xAI provider/model adapter.
    // This plugin only attaches OAuth/API-key auth and custom xAI tools to provider id "xai".
    tool: {
      xai_status: tool({
        description: "Show whether xAI OAuth/API-key credentials are available for this OpenCode plugin.",
        args: {},
        async execute() {
          const stored = readStoredAuth()
          try {
            const creds = await resolveXaiCredentials()
            return JSON.stringify({ success: true, credential_source: creds.provider, base_url: creds.baseUrl, oauth_file_present: Boolean(stored) }, null, 2)
          } catch (error) {
            return JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error), oauth_file_present: Boolean(stored) }, null, 2)
          }
        },
      }),
      xai_generate_text: tool({
        description: "Generate text with xAI Grok through the Responses API.",
        args: { prompt: tool.schema.string(), model: tool.schema.string().optional(), reasoning_effort: tool.schema.enum(["low", "medium", "high"]).optional() },
        async execute(args) {
          const result = await xaiResponses({ prompt: args.prompt, model: args.model, reasoningEffort: args.reasoning_effort })
          return { title: "xAI text", output: JSON.stringify({ success: true, answer: result.text, citations: result.citations, inline_citations: result.inline_citations }, null, 2) }
        },
      }),
      xai_x_search: tool({
        description: "Search X/Twitter posts, profiles, and threads using xAI's server-side x_search Responses API tool.",
        args: {
          query: tool.schema.string(),
          allowed_x_handles: tool.schema.array(tool.schema.string()).optional(),
          excluded_x_handles: tool.schema.array(tool.schema.string()).optional(),
          from_date: tool.schema.string().optional(),
          to_date: tool.schema.string().optional(),
          enable_image_understanding: tool.schema.boolean().optional(),
          enable_video_understanding: tool.schema.boolean().optional(),
          model: tool.schema.string().optional(),
        },
        async execute(args) {
          const allowed = handles(args.allowed_x_handles)
          const excluded = handles(args.excluded_x_handles)
          if (allowed.length && excluded.length) throw new Error("allowed_x_handles and excluded_x_handles cannot be used together")
          const toolDef: Record<string, unknown> = { type: "x_search" }
          if (allowed.length) toolDef.allowed_x_handles = allowed
          if (excluded.length) toolDef.excluded_x_handles = excluded
          if (args.from_date) toolDef.from_date = args.from_date
          if (args.to_date) toolDef.to_date = args.to_date
          if (args.enable_image_understanding) toolDef.enable_image_understanding = true
          if (args.enable_video_understanding) toolDef.enable_video_understanding = true
          const result = await xaiResponses({ prompt: args.query, model: args.model || "grok-4.20-reasoning", tools: [toolDef] })
          return JSON.stringify({ success: true, tool: "x_search", query: args.query, answer: result.text, citations: result.citations, inline_citations: result.inline_citations }, null, 2)
        },
      }),
      xai_web_search: tool({
        description: "Search the web using xAI/Grok native server-side web search through the Responses API.",
        args: { query: tool.schema.string(), model: tool.schema.string().optional() },
        async execute(args) {
          const result = await xaiResponses({ prompt: args.query, model: args.model || "grok-4.3", tools: [{ type: "web_search" }] })
          return JSON.stringify({ success: true, tool: "web_search", query: args.query, answer: result.text, citations: result.citations, inline_citations: result.inline_citations }, null, 2)
        },
      }),
      xai_image_generate: tool({
        description: "Generate images with xAI's image generation endpoint. Returns upstream JSON, usually URLs or base64 payloads.",
        args: { prompt: tool.schema.string(), model: tool.schema.string().optional(), n: tool.schema.number().int().min(1).max(4).optional(), size: tool.schema.string().optional(), response_format: tool.schema.enum(["url", "b64_json"]).optional() },
        async execute(args) {
          const data = await xaiImageGenerate(args)
          return JSON.stringify({ success: true, ...data }, null, 2)
        },
      }),
      xai_tts: tool({
        description: "Generate speech audio with xAI's OpenAI-compatible speech endpoint. Returns base64 audio for saving by the caller.",
        args: { input: tool.schema.string(), model: tool.schema.string().optional(), voice: tool.schema.string().optional(), format: tool.schema.string().optional() },
        async execute(args) {
          const result = await xaiTts(args)
          return { title: "xAI TTS", output: JSON.stringify({ success: true, content_type: result.contentType, audio_base64: result.bytes.toString("base64") }) }
        },
      }),
    },
    "shell.env": async (_input, output) => {
      try {
        const creds = await resolveXaiCredentials()
        output.env.XAI_API_KEY = creds.apiKey
        output.env.XAI_BASE_URL = creds.baseUrl
      } catch {
        // No credentials yet; keep shell unchanged.
      }
    },
    event: async ({ event }) => {
      if (event.type === "server.connected") await ctx.client.app.log({ body: { service: "opencode-xai-oauth", level: "info", message: "xAI OAuth plugin loaded" } }).catch(() => {})
    },
  }
}

export default XaiOAuthPlugin
