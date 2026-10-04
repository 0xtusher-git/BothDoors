"use client";

import { useState, type ReactNode } from "react";

/** A code block with a copy button. */
export function CodeBlock({
  code,
  language = "ts",
  label,
  maxHeight = "24rem",
  children,
}: {
  code?: string;
  language?: string;
  label?: string;
  maxHeight?: string;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const text = code ?? "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-door-line bg-black/40">
      <div className="flex items-center justify-between gap-2 border-b border-door-line px-3 py-2">
        <span className="font-mono text-[11px] text-door-dim">
          {label ?? language}
        </span>
        {code !== undefined ? (
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border border-door-line px-2 py-0.5 text-[11px] font-medium text-door-dim transition hover:border-door-accent hover:text-door-accent"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </div>
      <pre
        className="overflow-auto p-3 text-[12px] leading-relaxed"
        style={{ maxHeight }}
      >
        <code className="font-mono text-door-ink">{children ?? code}</code>
      </pre>
    </div>
  );
}
