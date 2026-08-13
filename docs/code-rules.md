# Design System

## Rule

**No hardcoded hex, rgba, or named CSS colors in `src/`.** The single source of truth is the `:root` block in `src/app/globals.css`. Components access values through the typed `color` object in `src/styles/tokens.ts`.

---

## Token Naming Convention

Format: `--color-<semantic-role>` — role describes *purpose*, not palette value.

| Good | Bad |
|------|-----|
| `--color-accent` | `--color-blue` |
| `--color-muted` | `--color-gray-400` |
| `--color-fragile-bg` | `--color-red-100` |

---

## Color Tokens

| Role | CSS Var | Purpose |
|------|---------|---------|
| `pageBg` | `--color-page-bg` | Warm-gray page canvas |
| `surface` | `--color-surface` | Card / panel background |
| `surfaceSub` | `--color-surface-sub` | Table header, inset section |
| `surfaceHover` | `--color-surface-hover` | Hovered row / disabled button fill |
| `border` | `--color-border` | Default border, divider |
| `borderStrong` | `--color-border-strong` | Focused/interactive border |
| `headerBg` | `--color-header-bg` | Sticky app header |
| `text` | `--color-text` | Primary body text |
| `textSub` | `--color-text-sub` | Secondary text |
| `muted` | `--color-muted` | Labels, placeholders, captions |
| `accent` | `--color-accent` | Interactive blue — buttons, links, active tabs |
| `accentDark` | `--color-accent-dark` | Hover state for accent |
| `accentMuted` | `--color-accent-muted` | Light accent fill (highlighted zones) |
| `accentBorder` | `--color-accent-border` | Accent-tinted border |
| `onAccent` | `--color-on-accent` | Text/icon on accent backgrounds |
| `fragile.*` | `--color-fragile-{bg,fg,border}` | Fragile item badges |
| `standard.*` | `--color-standard-{bg,fg,border}` | Standard item badges |
| `review.*` | `--color-review-{bg,fg,border}` | Needs-review badges |
| `error` | `--color-error` | Error text |
| `errorBg` | `--color-error-bg` | Error message background |
| `errorBorder` | `--color-error-border` | Error border |
| `statusIdle` | `--color-status-idle` | Header dot — idle state |
| `statusProcessing` | `--color-status-processing` | Header dot — processing |
| `statusDone` | `--color-status-done` | Header dot — complete |
| `shadow` | `--shadow-card` | Default card shadow |
| `shadowHover` | `--shadow-card-hover` | Elevated/hovered card shadow |

---

## Spacing Scale (numeric — stays in `tokens.ts`)

| Key | Value |
|-----|-------|
| `xs` | 4px |
| `sm` | 8px |
| `md` | 16px |
| `lg` | 24px |
| `xl` | 32px |
| `xxl` | 48px |

Used as: `padding: \`${spacing.lg}px\`` — React requires numbers for px arithmetic.

---

## Radius Scale

| Key | Value | Used on |
|-----|-------|---------|
| `card` | 12px | Cards, panels |
| `button` | 8px | Buttons, inputs |
| `badge` | 999px | Pills, status dots |
| `input` | 8px | Text inputs |

---

## Font Scale

| Key | Size | Used for |
|-----|------|----------|
| `xs` | 11px | Labels, captions, dimension callouts |
| `sm` | 12px | Table headers, secondary text |
| `base` | 13px | Body text, table cells |
| `md` | 15px | Subheadings |
| `lg` | 22px | Section headings |
| `xl` | 28px | Hero numbers (metric cards) |

---

## Component Composites

Pre-built `CSSProperties` objects in `tokens.ts` for consistent composition:

| Export | What it styles |
|--------|---------------|
| `card` | White surface card with border + shadow |
| `cardSection` | Same as `card` with top margin |
| `sectionLabel` | Uppercase label (`xs`, `muted`, 600) |
| `h2Style` / `h2` | Section heading (`md`, 600) |
| `th` | Table header cell |
| `td` | Table data cell |
| `tdMuted` | Muted table cell |
| `tdStrong` | Bold table cell |
| `pill(bg, fg, border)` | Fragility / status badge |
| `buttonPrimary(disabled)` | Accent-filled CTA button |
| `buttonSecondary(disabled)` | Outlined secondary button |

---

## Adding a New Color

1. Add to `:root` in `src/app/globals.css`: `--color-<role>: <hex>;`
2. Add typed accessor to `color` in `src/styles/tokens.ts`: `newRole: "var(--color-<role>)"`
3. Use `color.newRole` in components — never the raw hex

---

## Dark Mode Path

Change values in `:root` under a media query — no TypeScript changes needed:

```css
@media (prefers-color-scheme: dark) {
  :root {
    --color-page-bg:  #111318;
    --color-surface:  #1C1E29;
    /* ... */
  }
}
```
