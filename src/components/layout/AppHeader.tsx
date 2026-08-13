"use client";

import { color, font, spacing } from "@/styles/tokens";
import { ThemeToggle } from "./ThemeToggle";

interface Props {
  status: "idle" | "processing" | "done" | "error";
  filename?: string;
}

const statusConfig = {
  idle:       { dot: color.statusIdle,       label: "Ready" },
  processing: { dot: color.statusProcessing, label: "Processing…" },
  done:       { dot: color.statusDone,       label: "Complete" },
  error:      { dot: color.error,            label: "Error" },
} as const;

export function AppHeader({ status, filename }: Props) {
  const { dot, label } = statusConfig[status];

  return (
    <header
      style={{
        background: color.surface,
        borderBottom: `1px solid ${color.border}`,
        position: "sticky",
        top: 0,
        zIndex: 10,
      }}
    >
      <div
        style={{
          maxWidth: 1200,
          margin: "0 auto",
          padding: `0 ${spacing.xl}px`,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: spacing.lg,
        }}
      >
        {/* Logo + name */}
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm + 4 }}>
          <div
            aria-hidden="true"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: color.accent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: color.onAccent,
              fontSize: font.sm,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              flexShrink: 0,
            }}
          >
            L
          </div>
          <div>
            <span
              style={{
                fontSize: font.md,
                fontWeight: 700,
                color: color.text,
                letterSpacing: "-0.01em",
              }}
            >
              Logi
            </span>
            <span
              style={{
                fontSize: font.sm,
                color: color.muted,
                marginLeft: 8,
              }}
            >
              PDF Ingestion
            </span>
          </div>
        </div>

        {/* Right side: file name + status */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.md,
            fontSize: font.sm,
            color: color.muted,
          }}
        >
          {filename && (
            <span
              style={{
                maxWidth: 240,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={filename}
            >
              {filename}
            </span>
          )}
          <ThemeToggle />
          <div
            role="status"
            aria-live="polite"
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: dot,
                display: "inline-block",
                ...(status === "processing"
                  ? { animation: "pulse 1.4s ease-in-out infinite" }
                  : {}),
              }}
            />
            <span>{label}</span>
          </div>
        </div>
      </div>

      {/* Pulse keyframe injected inline — no global CSS file needed */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </header>
  );
}
