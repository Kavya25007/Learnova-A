import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  Bot,
  X,
  Send,
  Trash2,
  Copy,
  Check,
  Sparkles,
} from "lucide-react";

type Message = { role: "user" | "assistant"; content: string };

interface Props {
  notes?: string;
  apiBase: string;
}

// ── Code block with copy button ──────────────────────────────────────────────
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="my-2 rounded-lg overflow-hidden border border-border text-left">
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800 dark:bg-zinc-900">
        <span className="text-xs text-zinc-400 font-mono">{lang || "code"}</span>
        <button
          onClick={copy}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-white transition"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="bg-zinc-900 dark:bg-black p-3 overflow-x-auto text-sm text-zinc-100 m-0">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function MarkdownContent({
  content,
  streaming,
}: {
  content: string;
  streaming: boolean;
}) {
  const components: Components = {
    pre({ children }) {
      return <>{children}</>;
    },
    code({ className, children }) {
      const match = /language-(\w+)/.exec(className || "");
      if (!match) {
        return (
          <code className="bg-black/10 dark:bg-white/10 px-1.5 py-0.5 rounded text-[0.85em] font-mono break-words">
            {children}
          </code>
        );
      }
      return (
        <CodeBlock
          lang={match[1]}
          code={String(children).replace(/\n$/, "")}
        />
      );
    },
    p({ children }) {
      return <p className="mb-2 last:mb-0">{children}</p>;
    },
    ul({ children }) {
      return <ul className="list-disc pl-4 mb-2 space-y-0.5">{children}</ul>;
    },
    ol({ children }) {
      return <ol className="list-decimal pl-4 mb-2 space-y-0.5">{children}</ol>;
    },
    li({ children }) {
      return <li className="leading-relaxed">{children}</li>;
    },
    strong({ children }) {
      return <strong className="font-semibold">{children}</strong>;
    },
    h1({ children }) {
      return <h1 className="text-base font-bold mb-1.5 mt-2">{children}</h1>;
    },
    h2({ children }) {
      return <h2 className="text-sm font-bold mb-1.5 mt-2">{children}</h2>;
    },
    h3({ children }) {
      return <h3 className="text-sm font-semibold mb-1 mt-1.5">{children}</h3>;
    },
    blockquote({ children }) {
      return (
        <blockquote className="border-l-2 border-primary/40 pl-3 my-2 text-muted-foreground italic">
          {children}
        </blockquote>
      );
    },
    hr() {
      return <hr className="my-2 border-border" />;
    },
    a({ href, children }) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 text-primary hover:opacity-80"
        >
          {children}
        </a>
      );
    },
  };

  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
      {streaming && (
        <span className="inline-block w-0.5 h-3.5 bg-current opacity-70 animate-pulse ml-0.5 align-middle" />
      )}
    </div>
  );
}

// ── Single message bubble ─────────────────────────────────────────────────────
function MessageBubble({
  message,
  streaming,
}: {
  message: Message;
  streaming: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      {!isUser && (
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-primary to-accent grid place-items-center text-primary-foreground flex-shrink-0 mt-1">
          <Bot className="w-3.5 h-3.5" />
        </div>
      )}
      <div
        className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 ${
          isUser
            ? "bg-primary text-primary-foreground rounded-tr-sm text-sm leading-relaxed"
            : "bg-secondary text-secondary-foreground rounded-tl-sm"
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed">
            {message.content}
          </p>
        ) : message.content === "" && streaming ? (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground py-0.5">
            <span className="flex gap-0.5">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </span>
          </span>
        ) : (
          <MarkdownContent content={message.content} streaming={streaming} />
        )}
      </div>
    </div>
  );
}

// ── Suggested prompts shown on empty state ────────────────────────────────────
const SUGGESTED = [
  "How does this app work?",
  "What's the difference between Smart and Exact mode?",
  "Why are some slides being skipped?",
  "Which interval should I use for a coding tutorial?",
];

// ── Main Chat component ───────────────────────────────────────────────────────
export function Chat({ notes, apiBase }: Props) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 120);
    return () => clearTimeout(t);
  }, [open]);

  // Abort in-flight stream when panel closes
  const close = useCallback(() => {
    abortRef.current?.abort();
    setOpen(false);
  }, []);

  const send = useCallback(
    async (text?: string) => {
      const msg = (text ?? input).trim();
      if (!msg || streaming) return;

      const history: Message[] = [
        ...messages,
        { role: "user", content: msg },
      ];
      setMessages([...history, { role: "assistant", content: "" }]);
      setInput("");
      setStreaming(true);

      const abort = new AbortController();
      abortRef.current = abort;

      try {
        const res = await fetch(`${apiBase}/assistant/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: history,
            notes: notes || undefined,
          }),
          signal: abort.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Server error ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;
            const payload = line.slice(6);
            if (payload === "[DONE]") break;
            try {
              const { t } = JSON.parse(payload) as { t?: string };
              if (t) {
                setMessages((prev) => {
                  const next = [...prev];
                  const last = next[next.length - 1];
                  next[next.length - 1] = {
                    ...last,
                    content: last.content + t,
                  };
                  return next;
                });
              }
            } catch {
              // ignore malformed chunks
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant" && !last.content) {
              next[next.length - 1] = {
                role: "assistant",
                content: "Sorry, something went wrong. Please try again.",
              };
            }
            return next;
          });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [input, messages, streaming, notes, apiBase],
  );

  function clearChat() {
    abortRef.current?.abort();
    setStreaming(false);
    setMessages([]);
  }

  function autoResize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 128) + "px";
  }

  return (
    <>
      {/* Floating trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 pl-3.5 pr-4 py-2.5 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl transition-all hover:scale-105 active:scale-95"
        aria-label="Open AI Assistant"
      >
        <Sparkles className="w-4 h-4" />
        <span className="text-sm font-medium">AI Assistant</span>
      </button>

      {/* Overlay + panel */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:justify-end sm:p-6"
          onClick={close}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

          <div
            className="relative w-full sm:w-[430px] h-[calc(100dvh-0px)] sm:h-[640px] sm:max-h-[85vh] bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ── Header ── */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-accent grid place-items-center text-primary-foreground">
                  <Bot className="w-4 h-4" />
                </div>
                <div>
                  <p className="font-semibold text-sm leading-tight">
                    AI Assistant
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Powered by GPT · Ask anything
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-0.5">
                {messages.length > 0 && (
                  <button
                    onClick={clearChat}
                    title="Clear conversation"
                    className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  onClick={close}
                  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* ── Messages ── */}
            <div
              ref={scrollRef}
              className="flex-1 overflow-y-auto p-4 space-y-3 scroll-smooth"
            >
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center gap-4 py-6">
                  <div className="w-14 h-14 rounded-2xl bg-primary/10 grid place-items-center text-primary">
                    <Bot className="w-7 h-7" />
                  </div>
                  <div>
                    <p className="font-semibold text-base">How can I help?</p>
                    <p className="text-sm text-muted-foreground mt-1 max-w-[270px] leading-relaxed">
                      Ask me about the app, your notes, or any
                      topic — programming, AI, DBMS, DSA, anything.
                    </p>
                  </div>
                  <div className="w-full grid gap-2 mt-1">
                    {SUGGESTED.map((q) => (
                      <button
                        key={q}
                        onClick={() => send(q)}
                        className="text-left text-xs px-3.5 py-2.5 rounded-xl border border-border bg-background hover:bg-secondary transition text-muted-foreground hover:text-foreground leading-relaxed"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m, i) => (
                  <MessageBubble
                    key={i}
                    message={m}
                    streaming={
                      streaming &&
                      i === messages.length - 1 &&
                      m.role === "assistant"
                    }
                  />
                ))
              )}
            </div>

            {/* ── Input ── */}
            <div className="p-3 border-t border-border flex-shrink-0">
              <div className="flex items-end gap-2 bg-background rounded-xl border border-border focus-within:ring-2 focus-within:ring-ring px-3 py-2 transition">
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    autoResize(e.target);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Ask anything…"
                  className="flex-1 resize-none bg-transparent outline-none text-sm py-0.5 max-h-32 min-h-[20px] placeholder:text-muted-foreground"
                  style={{ height: "20px" }}
                />
                <button
                  onClick={() => send()}
                  disabled={!input.trim() || streaming}
                  className="p-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition hover:opacity-90 flex-shrink-0 self-end mb-0.5"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground text-center mt-1.5">
                Enter to send · Shift+Enter for new line
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
