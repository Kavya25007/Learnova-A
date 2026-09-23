/**
 * Binary resolver and startup health checks for external tools.
 *
 * yt-dlp is declared in replit.nix but may not be on PATH in an imported
 * project until the nix environment is rebuilt. This module resolves the
 * correct binary path at runtime by:
 *   1. Trying `which <tool>` (works once PATH is up to date)
 *   2. Globbing the nix store for the newest matching binary (reliable fallback)
 *
 * Resolved paths are cached so the glob only runs once per process.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { readdir } from "fs/promises";

const execFileAsync = promisify(execFile);

// ─── Nix store fallback paths ─────────────────────────────────────────────────
// These directories contain versioned yt-dlp builds. We sort by version string
// and pick the newest one.
const YT_DLP_NIX_GLOB_DIR = "/nix/store";

// Cache resolved paths across calls
const _resolved = new Map<string, string>();

/**
 * Resolve a binary to its absolute path.
 * Tries `which` first, then scans the nix store as fallback.
 */
export async function resolveBinary(name: string): Promise<string> {
  const cached = _resolved.get(name);
  if (cached) return cached;

  // 1. Try which — works when the nix env is fully active
  try {
    const { stdout } = await execFileAsync("which", [name], { timeout: 5_000 });
    const p = stdout.trim();
    if (p) {
      _resolved.set(name, p);
      return p;
    }
  } catch {
    // not on PATH — fall through to nix store scan
  }

  // 2. Scan the nix store for yt-dlp builds, sorted newest-version-first, and
  //    call each candidate directly via execFileAsync (no shell involved).
  //    Shell globs on /nix/store don't work from inside Node.js workflow
  //    processes on Replit due to filesystem namespace differences, but direct
  //    execFileAsync calls on absolute nix store paths work fine.
  if (name === "yt-dlp") {
    try {
      const storeEntries = await readdir(YT_DLP_NIX_GLOB_DIR);
      const ytdlpEntries = storeEntries.filter((e) => e.includes("yt-dlp") && !e.includes("-dist"));

      // Extract YYYY.MM.DD version from the entry name for sorting
      function extractVersion(entry: string): string {
        const m = entry.match(/yt-dlp-(\d{4}\.\d+\.\d+)/);
        return m ? m[1] : "0000.00.00";
      }

      // Sort newest-first
      ytdlpEntries.sort((a, b) => extractVersion(b).localeCompare(extractVersion(a)));

      for (const entry of ytdlpEntries) {
        const bin = `${YT_DLP_NIX_GLOB_DIR}/${entry}/bin/yt-dlp`;
        try {
          const { stdout: ver } = await execFileAsync(bin, ["--version"], { timeout: 5_000 });
          _resolved.set(name, bin);
          process.stderr.write(`[tools] yt-dlp resolved: ${bin} (${ver.trim()})\n`);
          return bin;
        } catch {
          continue;
        }
      }
    } catch {
      // nix store not readable — fall through
    }
  }

  throw new Error(
    `Binary "${name}" not found. ` +
    `It is declared in replit.nix but not on PATH. ` +
    `Try reloading the Replit environment (Shell → restart) or running ` +
    `"nix-env -i ${name}" in the shell.`,
  );
}

/**
 * Return the resolved path for yt-dlp (cached after first call).
 */
export async function getYtDlpPath(): Promise<string> {
  return resolveBinary("yt-dlp");
}

/**
 * Return the resolved path for ffmpeg (cached after first call).
 */
export async function getFfmpegPath(): Promise<string> {
  return resolveBinary("ffmpeg");
}

/**
 * Return the resolved path for ffprobe (cached after first call).
 */
export async function getFfprobePath(): Promise<string> {
  return resolveBinary("ffprobe");
}

// ─── Startup checks ───────────────────────────────────────────────────────────

export interface ToolStatus {
  name: string;
  path: string | null;
  version: string | null;
  ok: boolean;
  error?: string;
}

/**
 * Verify that yt-dlp, ffmpeg, and ffprobe are available and print their
 * versions to the log. Called once at server startup so missing tools are
 * obvious immediately rather than surfacing only when a user tries to
 * process a YouTube video.
 */
export async function verifyTools(
  log: { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void },
): Promise<void> {
  const tools: Array<{ name: string; versionFlag: string; resolver: () => Promise<string> }> = [
    { name: "yt-dlp",  versionFlag: "--version", resolver: getYtDlpPath },
    { name: "ffmpeg",  versionFlag: "-version",  resolver: getFfmpegPath },
    { name: "ffprobe", versionFlag: "-version",  resolver: getFfprobePath },
  ];

  const results: ToolStatus[] = [];

  for (const tool of tools) {
    try {
      const path = await tool.resolver();
      const { stdout } = await execFileAsync(path, [tool.versionFlag], { timeout: 8_000 });
      const version = stdout.trim().split("\n")[0]?.slice(0, 120) ?? "unknown";
      results.push({ name: tool.name, path, version, ok: true });
      log.info({ tool: tool.name, path, version }, `${tool.name} OK`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ name: tool.name, path: null, version: null, ok: false, error });
      log.warn({ tool: tool.name, error }, `${tool.name} NOT available — YouTube processing may fail`);
    }
  }

  const missing = results.filter((r) => !r.ok).map((r) => r.name);
  if (missing.length > 0) {
    log.warn(
      { missing },
      `Missing tools: ${missing.join(", ")}. ` +
      `YouTube video processing will be unavailable until these are installed.`,
    );
  } else {
    log.info({ tools: results.map((r) => `${r.name}@${r.version}`) }, "All tools verified OK");
  }
}
