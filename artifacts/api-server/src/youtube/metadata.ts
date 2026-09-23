import { getYtDlpPath } from "../lib/tools";
import { classifyYouTubeError } from "./errors";
import { runProcess, withBackoff } from "./subprocess";
import type { ParsedYouTubeUrl } from "./url";

export interface YouTubeMetadata {
  title: string;
  channel: string;
  thumbnail: string;
  videoId: string;
}

type Log = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function isRetryableHttpError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 5\d\d|aborted|timeout|ECONNRESET|network/i.test(message);
}

export async function fetchYouTubeMetadata(
  parsed: ParsedYouTubeUrl,
  log: Log,
): Promise<YouTubeMetadata> {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(parsed.canonicalUrl)}&format=json`;

  try {
    const data = await withBackoff(
      async () => {
        const response = await fetchWithTimeout(oembedUrl, 8_000);
        if (!response.ok) throw new Error(`oEmbed HTTP ${response.status}`);
        return (await response.json()) as {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
        };
      },
      isRetryableHttpError,
      { attempts: 3, baseDelayMs: 400 },
    );

    return {
      title: data.title ?? "",
      channel: data.author_name ?? "",
      thumbnail: data.thumbnail_url ?? "",
      videoId: parsed.videoId,
    };
  } catch (oembedError) {
    const rawOembedError =
      oembedError instanceof Error ? oembedError.message : String(oembedError);
    log.warn(
      { videoId: parsed.videoId, error: rawOembedError },
      "YouTube oEmbed metadata failed; trying yt-dlp metadata",
    );
  }

  try {
    const ytdlpBin = await getYtDlpPath();
    const result = await withBackoff(
      async () => {
        const output = await runProcess(
          ytdlpBin,
          [
            "--dump-single-json",
            "--skip-download",
            "--no-playlist",
            "--no-warnings",
            "--no-check-certificate",
            parsed.canonicalUrl,
          ],
          { timeoutMs: 20_000 },
        );
        if (output.timedOut) throw new Error("yt-dlp metadata request timed out.");
        if (output.code !== 0) {
          throw new Error((output.stderr + "\n" + output.stdout).trim());
        }
        return output;
      },
      (error) =>
        classifyYouTubeError(error instanceof Error ? error.message : String(error)).retryable,
      { attempts: 2, baseDelayMs: 750 },
    );

    const data = JSON.parse(result.stdout) as {
      title?: string;
      uploader?: string;
      channel?: string;
      thumbnail?: string;
    };
    log.info({ videoId: parsed.videoId, stderr: result.stderr || undefined }, "yt-dlp metadata succeeded");
    return {
      title: data.title ?? "",
      channel: data.uploader ?? data.channel ?? "",
      thumbnail: data.thumbnail ?? "",
      videoId: parsed.videoId,
    };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    log.warn({ videoId: parsed.videoId, stderr: raw }, "yt-dlp metadata failed");
    throw error;
  }
}