import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, parse } from "node:path";

interface ArtifactsPathApi {
  isAbsolute(path: string): boolean;
  join(...paths: readonly string[]): string;
  parse(path: string): { root: string };
}

const defaultPathApi: ArtifactsPathApi = {
  isAbsolute,
  join,
  parse,
};

function resolveArtifactsDir(
  worktree: string | undefined | null,
  pathApi: ArtifactsPathApi = defaultPathApi
): string {
  const candidates = [
    typeof worktree === "string" ? worktree.trim() : "",
    process.env.OPENCODE_XAI_ARTIFACTS_DIR || "",
    process.env.HOME || "",
    homedir() || "",
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (!pathApi.isAbsolute(candidate)) {
      continue;
    }
    if (candidate === pathApi.parse(candidate).root) {
      continue;
    }
    return pathApi.join(candidate, ".opencode", "artifacts");
  }

  return join(tmpdir(), "opencode-xai-artifacts");
}

function ensureArtifactsDir(
  worktree: string | undefined | null,
  pathApi: ArtifactsPathApi = defaultPathApi
): string {
  const artifactsDir = resolveArtifactsDir(worktree, pathApi);
  try {
    mkdirSync(artifactsDir, { recursive: true });
    return artifactsDir;
  } catch (error) {
    const fallback = join(tmpdir(), "opencode-xai-artifacts");
    if (fallback === artifactsDir) {
      throw error;
    }
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export async function downloadMediaToArtifacts(
  url: string,
  filename: string,
  worktree: string
): Promise<string> {
  const artifactsDir = ensureArtifactsDir(worktree);
  const filePath = join(artifactsDir, filename);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download media: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(filePath, buffer);

  return filePath;
}

export function saveBase64Image(
  b64Data: string,
  filename: string,
  worktree: string
): string {
  const artifactsDir = ensureArtifactsDir(worktree);
  const filePath = join(artifactsDir, filename);
  const buffer = Buffer.from(b64Data, "base64");
  writeFileSync(filePath, buffer);

  return filePath;
}

export const __testing = {
  ensureArtifactsDir,
  resolveArtifactsDir,
};
