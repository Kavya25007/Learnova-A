import { mkdir, readdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import os from "os";
import { getYtDlpPath } from "../lib/tools";
import { classifyYouTubeError, isTranscriptUnavailable } from "./errors";
import { runProcess, withBackoff } from "./subprocess";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export type TranscriptResult =
  | { status: "available"; segments: TranscriptSegment[]; duration: number }
  | { status: "unavailable"; reason: "no_captions" | "blocked"; raw?: string };

type Log = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

function parseTimestamp(value: string): number {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function cleanCueText(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVtt(vtt: string): TranscriptSegment[] {
  const lines = vtt.replace(/^\uFEFF/, "").split(/\r?\n/);
  const segments: TranscriptSegment[] = [];
  let i = 0;

  while (i < lines.length) {
    const timing = lines[i].match(
      /^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3})/,
    );
    if (!timing) {
      i++;
      continue;
    }

    const textLines: string[] = [];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i]);
      i++;
    }
    const text = cleanCueText(textLines.join(" "));
    const previous = segments[segments.length - 1];
    if (text && text !== previous?.text) {
      segments.push({
        start: parseTimestamp(timing[1]),
        end: parseTimestamp(timing[2]),
        text,
      });
    }
    i++;
  }

  return segments;
}

function chunkSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  const chunks: TranscriptSegment[] = [];
  let current = "";
  let start = 0;
  let end = 0;

  for (const segment of segments) {
    if (!current) start = segment.start;
    if (current && current.length + segment.text.length + 1 > 1800) {
      chunks.push({ start, end, text: current });
      current = "";
      start = segment.start;
    }
    current = current ? `${current} ${segment.text}` : segment.text;
    end = segment.end;
  }
  if (current) chunks.push({ start, end, text: current });
  return chunks;
}

export async function extractYouTubeTranscript(
  videoUrl: string,
  log: Log,
): Promise<TranscriptResult> {
  const tempDir = join(os.tmpdir(), `yt-transcript-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true });
  const outputTemplate = join(tempDir, "captions.%(ext)s");

  try {
    const ytdlpBin = await getYtDlpPath();
    const clients = ["android", "ios", "tv_embedded"];
    
    let lastResult: { status: "available"; segments: TranscriptSegment[]; duration: number } | null = null;
    let lastError = "";

    for (const client of clients) {
      const args = [
        "--no-playlist",
        "--no-check-certificate",
        "--extractor-args", `youtube:player_client=${client}`,
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        "en,en-US,en-GB,en-IN",
        "--sub-format",
        "vtt",
        "--output",
        outputTemplate,
        videoUrl,
      ];

      try {
        const result = await withBackoff(
          async () => {
            const output = await runProcess(ytdlpBin, args, { timeoutMs: 30_000 });
            if (output.timedOut) {
              throw new Error("Transcript extraction timed out.");
            }
            if (output.code !== 0) {
              throw new Error((output.stderr + "\n" + output.stdout).trim());
            }
            return output;
          },
          (error) => classifyYouTubeError(error instanceof Error ? error.message : String(error)).retryable,
          { attempts: 2, baseDelayMs: 750 },
        );

        log.info(
          { videoUrl, client, stderr: result.stderr.trim() || undefined },
          "YouTube transcript command completed",
        );

        const files = (await readdir(tempDir)).filter((file) => file.endsWith(".vtt"));
        if (files.length > 0) {
          const rawVtt = await readFile(join(tempDir, files[0]), "utf8");
          const segments = chunkSegments(parseVtt(rawVtt));
          if (segments.length > 0) {
            const last = segments[segments.length - 1];
            lastResult = {
              status: "available",
              segments,
              duration: last ? last.end : 0,
            };
            break; // Success, exit client loop
          }
        }
        
        // If we get here, yt-dlp succeeded but no captions were generated.
        // There's no point trying another client if the video simply lacks captions.
        break; 

      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        log.warn({ videoUrl, client, err: lastError.slice(0, 600) }, "Transcript extraction client failed");
        
        // Stop early for definitive blocks
        if (/private video|video is private/i.test(lastError)) break;
        if (/age.?restrict|confirm your age/i.test(lastError)) break;
        if (/unavailable.*app|not available.*app/i.test(lastError)) continue;
      }
    }

    if (lastResult) return lastResult;

    return { status: "unavailable", reason: "no_captions" };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    log.warn({ videoUrl, stderr: raw }, "YouTube transcript extraction failed — will fallback to video processing");
    return { status: "unavailable", reason: "no_captions", raw };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}