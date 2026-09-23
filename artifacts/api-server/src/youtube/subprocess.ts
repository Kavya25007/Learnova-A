import { spawn } from "child_process";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ProcessOptions {
  timeoutMs: number;
  onStdout?: (text: string) => void;
}

/**
 * Run an external process with complete output capture and a hard timeout.
 * The timeout kills the process so a failed YouTube job cannot remain active
 * forever while its SSE client waits.
 */
export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withBackoff<T>(
  operation: (attempt: number) => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  options: { attempts: number; baseDelayMs: number },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === options.attempts - 1 || !shouldRetry(error)) throw error;
      await sleep(options.baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}