"use client";

import { useRef, useState } from "react";
import { color, font, spacing, radius } from "@/styles/tokens";
import { ErrorBanner } from "@/components/common/ErrorBanner";

interface Props {
  loading: boolean;
  hasFile: boolean;
  filename?: string;
  error: string | null;
  onSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRerun: () => void;
}

export function DropZone({ loading, hasFile, filename, error, onSelect, onRerun }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onSelect(e);
    // Browsers skip the change event on re-selecting an unchanged FileList —
    // clear it so the same PDF can be picked again after Start Over.
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file || loading) return;
    // Synthesise a change event from the dropped file
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = inputRef.current;
    if (input) {
      // Assign directly — `input.files` is a settable property in modern
      // browsers. The old Object.defineProperty approach made it
      // non-configurable, so a second drop threw "Cannot redefine property".
      (input as unknown as { files: FileList }).files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  const zoneStyle: React.CSSProperties = {
    border: `2px dashed ${dragging ? color.accent : error ? color.errorBorder : color.borderStrong}`,
    borderRadius: radius.card,
    padding: `${spacing.xxl}px ${spacing.xl}px`,
    textAlign: "center",
    cursor: loading ? "not-allowed" : "pointer",
    background: dragging ? color.accentMuted : error ? color.errorBg : color.surfaceSub,
    transition: "border-color 0.15s, background 0.15s",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: spacing.sm,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.md }}>
      {/* Hidden real file input */}
      <input
        ref={inputRef}
        id="pdf-upload"
        type="file"
        accept="application/pdf"
        onChange={handleChange}
        disabled={loading}
        aria-label="Upload PDF file"
        style={{ display: "none" }}
      />

      {/* Drag-drop zone */}
      {/* UX fix H6: visible label + drag affordance instead of bare browser input */}
      <div
        role="button"
        tabIndex={loading ? -1 : 0}
        aria-label="Drop a PDF here or press Enter to browse"
        style={zoneStyle}
        onClick={() => !loading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!loading && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {/* Upload icon */}
        <svg
          aria-hidden="true"
          width={32}
          height={32}
          viewBox="0 0 24 24"
          fill="none"
          stroke={dragging ? color.accent : color.muted}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>

        {hasFile && filename ? (
          <>
            <span style={{ fontSize: font.md, fontWeight: 600, color: color.text }}>
              {filename}
            </span>
            <span style={{ fontSize: font.sm, color: color.muted }}>
              Click to replace or drop a new PDF
            </span>
          </>
        ) : (
          <>
            <span style={{ fontSize: font.md, fontWeight: 600, color: color.text }}>
              Drop a PDF here
            </span>
            <span style={{ fontSize: font.sm, color: color.muted }}>
              or <span style={{ color: color.accent, fontWeight: 500 }}>click to browse</span>
            </span>
          </>
        )}
      </div>

      {/* Action row */}
      {hasFile && (
        <div style={{ display: "flex", gap: spacing.sm }}>
          <button
            onClick={onRerun}
            disabled={loading}
            aria-busy={loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 16px",
              borderRadius: radius.button,
              border: `1px solid ${loading ? color.border : color.borderStrong}`,
              background: color.surface,
              color: loading ? color.muted : color.text,
              cursor: loading ? "not-allowed" : "pointer",
              fontSize: font.base,
              fontWeight: 500,
              outline: "none",
            }}
          >
            {/* Refresh icon */}
            <svg
              aria-hidden="true"
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="1 4 1 10 7 10" />
              <path d="M3.51 15a9 9 0 1 0 .49-3.18" />
            </svg>
            {loading ? "Processing…" : "Re-run"}
          </button>
        </div>
      )}

      {/* Error message */}
      {/* UX fix H9: actionable error with context */}
      {error && (
        <ErrorBanner
          icon
          style={{ padding: `${spacing.sm + 2}px ${spacing.md}px`, borderRadius: radius.card, fontSize: font.base }}
        >
          {error} Try uploading the file again.
        </ErrorBanner>
      )}
    </div>
  );
}
