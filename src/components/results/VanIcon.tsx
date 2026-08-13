"use client";

import { color } from "@/styles/tokens";

/**
 * Side-profile van silhouette whose proportions are driven by the real interior
 * dimensions, so the shape itself reads as the vehicle class: a long box truck
 * draws wide and boxy, a micro panel van draws short and low. Magnitude (how big
 * the van is overall) is carried by `px`; the caller sizes that from volume so a
 * row of icons becomes an honest size ramp rather than identical blocks.
 */

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function VanIcon({
  lengthMm,
  heightMm,
  px = 44,
  fill = color.accentMuted,
  edge = color.accentBorder,
  title,
}: {
  lengthMm: number;
  heightMm: number;
  /** Rendered width in px; height follows the fixed viewBox ratio. */
  px?: number;
  fill?: string;
  edge?: string;
  title?: string;
}) {
  // Aspect = how long the cargo body is relative to its height. Clamped so even
  // the most extreme van stays legible as a vehicle.
  const aspect = clamp(lengthMm / heightMm, 1, 3.2);

  const VB_W = 120;
  const VB_H = 96;
  const margin = 6;
  const bodyW = VB_W - margin * 2; // 108
  const bodyH = clamp(bodyW / aspect, 30, 70); // boxier (taller) for trucks
  const wheelR = clamp(bodyH * 0.2, 7, 12);

  const top = (VB_H - wheelR * 2 - bodyH) / 2;
  const bottom = top + bodyH;
  const x0 = margin;
  const x1 = x0 + bodyW;
  const wheelY = bottom + wheelR * 0.55;
  // Cab windshield: a short slanted front so it reads as a driving direction.
  const cabX = x1 - bodyW * 0.2;
  const cabTop = top + bodyH * 0.22;

  const bodyPath = [
    `M ${x0} ${bottom}`,
    `L ${x0} ${top + 6}`,
    `Q ${x0} ${top} ${x0 + 6} ${top}`, // rounded rear-top corner
    `L ${cabX} ${top}`,
    `L ${x1} ${cabTop}`, // slanted windshield down to bonnet
    `L ${x1} ${bottom}`,
    `Z`,
  ].join(" ");

  return (
    <svg
      width={px}
      height={(px * VB_H) / VB_W}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      style={{ display: "block", flexShrink: 0 }}
    >
      {title && <title>{title}</title>}
      <path d={bodyPath} fill={fill} stroke={edge} strokeWidth={3} strokeLinejoin="round" />
      {/* Cab/cargo divider so the silhouette doesn't read as a plain block. */}
      <line x1={cabX} y1={top} x2={cabX} y2={bottom} stroke={edge} strokeWidth={2} opacity={0.6} />
      {/* Wheels — rear axle and front axle, positioned under the body span. */}
      <circle cx={x0 + bodyW * 0.22} cy={wheelY} r={wheelR} fill={edge} />
      <circle cx={x1 - bodyW * 0.16} cy={wheelY} r={wheelR} fill={edge} />
    </svg>
  );
}
