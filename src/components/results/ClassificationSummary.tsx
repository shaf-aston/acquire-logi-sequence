"use client";

import { pill, color, font, spacing } from "@/styles/tokens";
import type { ClassificationResult } from "@/types/api";

export function ClassificationSummary({
  classification,
}: {
  classification: ClassificationResult;
}) {
  const { fragile, standard, lowConfidence } = classification.counts;
  const total = fragile + standard;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: spacing.sm }}>
      <p style={{ fontSize: font.xs, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.07em", color: color.muted, margin: 0 }}>
        Classification
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm }}>
        <span style={pill(color.standard.bg, color.standard.fg, color.standard.border)}>
          <svg aria-hidden="true" width={10} height={10} viewBox="0 0 10 10" fill="currentColor">
            <circle cx="5" cy="5" r="5" />
          </svg>
          Standard — {standard}
        </span>
        <span style={pill(color.fragile.bg, color.fragile.fg, color.fragile.border)}>
          <svg aria-hidden="true" width={10} height={10} viewBox="0 0 10 10" fill="currentColor">
            <circle cx="5" cy="5" r="5" />
          </svg>
          Fragile — {fragile}
        </span>
        {lowConfidence > 0 && (
          <span style={pill(color.review.bg, color.review.fg, color.review.border)}>
            <svg aria-hidden="true" width={10} height={10} viewBox="0 0 10 10" fill="currentColor">
              <circle cx="5" cy="5" r="5" />
            </svg>
            Needs review — {lowConfidence}
          </span>
        )}
      </div>
      {total > 0 && (
        <div
          style={{
            height: 6,
            borderRadius: 999,
            background: color.border,
            overflow: "hidden",
            marginTop: 2,
          }}
          role="presentation"
          aria-hidden="true"
        >
          <div
            style={{
              height: "100%",
              width: `${(standard / total) * 100}%`,
              background: color.standard.fg,
              borderRadius: 999,
            }}
          />
        </div>
      )}
    </div>
  );
}
