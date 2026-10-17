/**
 * Binary resolver and startup health checks for external tools.
 *
 * Resolves the correct binary path at runtime by:
 *   1. Trying `where` (Windows) or `which` (Unix/macOS) — works when the tool is on PATH
 *   2. Trying common Windows installation paths for yt-dlp as a fallback
 *
 * Resolved paths are cached so the lookup only runs once per process.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { access } from "fs/promises";
import { constants as fsConstants } from "fs";
import os from "os";

const execFileAsync = promisify(execFile);

// Cache resolved paths across calls
const _resolved = new Map<string, string>();

/** Return the OS-appropriate "which" command name. */
function whichCommand(): string {
  return process.platform === "win32" ? "where" : "which";
}

/**
 * Common fallback paths to try on Windows when the tool is not on PATH.
 * These cover the most common pip/pipx/scoop/winget install locations.
 */
function getWindowsFallbackPaths(name: string): string[] {
  const home = os.homedir();
  const appData = process.env["APPDATA"] ?? `${home}\\AppData\\Roaming`;
  const localAppData = process.env["LOCALAPPDATA"] ?? `${home}\\AppData\\Local`;

  if (name === "yt-dlp") {
    return [
      // pip / pip3 install location (Python Scripts)
      `${localAppData}\\Programs\\Python\\Python314\\Scripts\\yt-dlp.exe`,
      `${localAppData}\\Programs\\Python\\Python313\\Scripts\\yt-dlp.exe`,
      `${localAppData}\\Programs\\Python\\Python312\\Scripts\\yt-dlp.exe`,
      `${localAppData}\\Programs\\Python\\Python311\\Scripts\\yt-dlp.exe`,
      `${localAppData}\\Programs\\Python\\Python310\\Scripts\\yt-dlp.exe`,
      `${home}\\AppData\\Local\\Programs\\Python\\Python314\\Scripts\\yt-dlp.exe`,
      // pipx
      `${localAppData}\\pipx\\venvs\\yt-dlp\\Scripts\\yt-dlp.exe`,
      `${home}\\.local\\bin\\yt-dlp.exe`,
      // scoop
      `${home}\\scoop\\shims\\yt-dlp.exe`,
      // winget / manual
      `C:\\yt-dlp\\yt-dlp.exe`,
      `C:\\tools\\yt-dlp\\yt-dlp.exe`,
      // Roaming scripts
      `${appData}\\Python\\Scripts\\yt-dlp.exe`,
    ];
  }

  if (name === "ffmpeg" || name === "ffprobe") {
    const exe = `${name}.exe`;
    return [
      `C:\\ffmpeg\\ffmpeg\\bin\\${exe}`,
      `C:\\ffmpeg\\bin\\${exe}`,
      `C:\\Program Files\\ffmpeg\\bin\\${exe}`,
      `C:\\Program Files (x86)\\ffmpeg\\bin\\${exe}`,
      `${home}\\scoop\\apps\\ffmpeg\\current\\bin\\${exe}`,
      `C:\\tools\\ffmpeg\\bin\\${exe}`,
    ];
  }

  return [];
}

/**
 * Resolve a binary to its absolute path.
 * Tries `where`/`which` first, then platform-specific fallback paths.
 */
export async function resolveBinary(name: string): Promise<string> {
  const cached = _resolved.get(name);
  if (cached) return cached;

  // 1. Try where/which — works when the tool is on PATH
  try {
    const whichCmd = whichCommand();
    const { stdout } = await execFileAsync(whichCmd, [name], { timeout: 5_000 });
    // `where` on Windows returns multiple lines; take the first non-empty one
    const p = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (p) {
      _resolved.set(name, p);
      return p;
    }
  } catch {
    // not on PATH — fall through to fallback paths
  }

  // 2. Try common installation paths (platform-specific)
  const fallbacks = getWindowsFallbackPaths(name);
  for (const candidate of fallbacks) {
    try {
      await access(candidate, fsConstants.X_OK);
      // Also verify it actually runs
      const versionFlag = name === "ffmpeg" || name === "ffprobe" ? "-version" : "--version";
      await execFileAsync(candidate, [versionFlag], { timeout: 5_000 });
      _resolved.set(name, candidate);
      process.stderr.write(`[tools] ${name} resolved via fallback: ${candidate}\n`);
      return candidate;
    } catch {
      continue;
    }
  }

  // 3. Last resort: maybe it's available as just the name (trust the OS)
  //    Try calling it directly — if it works, use it
  try {
    const versionFlag = name === "ffmpeg" || name === "ffprobe" ? "-version" : "--version";
    await execFileAsync(name, [versionFlag], { timeout: 5_000 });
    _resolved.set(name, name);
    return name;
  } catch {
    // genuinely not found
  }

  const installGuide = name === "yt-dlp"
    ? `Run: pip install yt-dlp  (or visit https://github.com/yt-dlp/yt-dlp#installation)`
    : `Download from https://ffmpeg.org/download.html and add to PATH`;

  throw new Error(
    `Binary "${name}" not found on PATH or common installation locations.\n` +
    `${installGuide}\n` +
    `After installing, restart the server.`,
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
