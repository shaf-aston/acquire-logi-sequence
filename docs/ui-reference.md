# UI Reference — Moverta Aesthetic

Visual target for all UI work. Every screen should feel like this dashboard: clean white cards on a warm-gray canvas, data-dense but not cluttered, 3D assets given breathing room.

---

## Layout

Two-column grid matching `.page-grid` in `globals.css`:

```
| 320px sidebar  |  1fr detail panel  |
```

- Sidebar: scrollable vehicle list
- Detail: selected vehicle render + stats
- Gap: `spacing.xl` (32px)
- Collapses to single column on mobile

---

## Left Sidebar — Vehicle List

### Card anatomy (per vehicle)

```
[ 64×48 thumbnail ]  Vehicle Name          [+]
                     L × W × H cm
                     weight kg
```

- Card: `tokens.card` (white, 12px radius, shadow-card)
- **Active card**: `shadow-card-hover`, white bg — visually elevated
- Thumbnail: object-fit cover, `radius.button` corners, `surfaceSub` placeholder
- Name: `font.md` (15px), `600`, `color.text`
- Dimensions: `font.sm` (12px), `color.muted`, prefix with ruler icon
- Weight: `font.sm`, `color.muted`, prefix with weight icon
- `+` button: `color.accent` background, `color.onAccent` text, `radius.button`, 28×28px
- Three-dot overflow menu (`color.muted`) on left edge, appears on hover

### Spacing

- Card padding: `spacing.lg` (24px)
- Gap between cards: `spacing.sm` (8px)
- Thumbnail margin-right: `spacing.md` (16px)

---

## Detail Panel — Vehicle View

### Header

- Vehicle name: `font.xl` (28px), `700`, `color.text`, letter-spacing `-0.01em`
- Dimensions string: `font.sm`, `color.muted`, below name

### 3D Render Zone

- Full panel width, `radius.card` overflow hidden
- Warm `color.surfaceSub` background behind render
- Left/right arrow controls for rotate: `color.surface` circle buttons, `color.border` border
- Render height: ~360px desktop

### Engine Specs Row (below render)

Three inline groups separated by `color.border` dividers:

```
Engine       Turbine type    Torque
XC13G        eWG             1,000 – 1,500 rpm
```

- Label: `font.sm`, `color.muted`
- Value: `font.base`, `color.text`, `600`

---

## Metric Stat Cards (Section Panel)

Right-side stack for load distribution per section:

```
Section 1
  4200
  kg
  3.91    PSI
  12 cm   Loaded space
```

- Card: `tokens.card`
- Section label: `tokens.sectionLabel`
- Primary number: `font.xl` (28px), `700`, `color.text`
- Unit: `font.xs`, `color.muted`
- Secondary rows: two-column — value (`font.sm`, `600`) | label (`font.xs`, `color.muted`)

---

## Section Load Diagram (Bottom Center)

Schematic side-view of the vehicle:

- Drawn as SVG or Canvas outline
- Load zones highlighted: `color.accentMuted` (blue) for standard load, green (`color.standard-bg`) for active section
- Dimension callouts: `font.xs`, `color.muted`, with bracket lines
- Tire pressure indicators below axles: color-coded bar (red → orange → green) with PSI value

---

## Navigation Tabs

Horizontal tab row at top of main content:

- Active tab: pill shape, `color.accent` background, `color.onAccent` text, `radius.button`
- Inactive tabs: `color.surfaceHover` on hover, `color.muted` text
- Tab icons: 16px, same color as label
- Gap between tabs: `spacing.sm`

---

## Search Bar

Top-right of header:

- `color.surface` background, `color.border` border, `radius.input` corners
- Placeholder: `color.muted`
- Icon: magnifier, `color.muted`, left-inset
- Width: ~200px, expands on focus

---

## Status Indicator (App Header)

7px dot + text label, right of header:

| State | Dot color token | Label |
|-------|----------------|-------|
| idle | `color.statusIdle` | Ready |
| processing | `color.statusProcessing` | Processing… (pulse animation) |
| done | `color.statusDone` | Complete |
| error | `color.error` | Error |

---

## Typography Rules

- Font family: system-ui / Inter — no custom font load required for MVP
- All caps labels: `tokens.sectionLabel` (`font.xs`, `600`, `0.07em` tracking)
- Numbers in metric cards: tabular figures if available (`font-variant-numeric: tabular-nums`)
- No decorative text effects — weight and size carry hierarchy

---

## Whitespace Principles

- Cards never touch each other — minimum `spacing.sm` gap
- Content inside cards: `spacing.lg` padding on all sides
- Breathing room around 3D renders: no content within `spacing.md` of the render edge
- Stat cards: compact but not cramped — `spacing.sm` between rows within a card
