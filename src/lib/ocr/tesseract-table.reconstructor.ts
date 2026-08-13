/**
 * Reconstructs tables from OCR word boxes (Tesseract gives words + pixel
 * coordinates, not structure). Output is GitHub-flavoured markdown so it flows
 * straight into the existing markdown-table parser — no special-casing
 * downstream. Pure + deterministic; all thresholds injected, none hardcoded.
 *
 * Strategy:
 *   1. Cluster words into rows by vertical position.
 *   2. Split rows into segments of consecutive "tabular" rows (≥ minColumns words).
 *   3. Per segment, cluster word x-positions into columns and place each word.
 *   4. Emit multi-row segments as markdown tables; everything else as plain text.
 */

export interface OcrWord {
  readonly text: string;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly confidence: number;
}

export interface ReconstructOptions {
  readonly minConfidence: number;
  readonly rowGapFactor: number;
  readonly colGapFactor: number;
  readonly minColumns: number;
  readonly minTableRows: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

const centerY = (w: OcrWord) => (w.y0 + w.y1) / 2;

/** Group words into visual rows using the vertical gap between sorted centers. */
function clusterRows(words: OcrWord[], rowGap: number): OcrWord[][] {
  const sorted = [...words].sort((a, b) => centerY(a) - centerY(b));
  const rows: OcrWord[][] = [];
  let current: OcrWord[] = [];
  let prevY = Number.NaN;

  for (const w of sorted) {
    const cy = centerY(w);
    if (current.length > 0 && cy - prevY > rowGap) {
      rows.push(current);
      current = [];
    }
    current.push(w);
    prevY = cy;
  }
  if (current.length > 0) rows.push(current);
  return rows.map((r) => [...r].sort((a, b) => a.x0 - b.x0));
}

/** Cluster word left-edges across a segment into column anchor positions. */
function detectColumns(rows: OcrWord[][], colGap: number): number[] {
  const xs = rows.flat().map((w) => w.x0).sort((a, b) => a - b);
  const centers: number[] = [];
  let bucket: number[] = [];
  let prev = Number.NaN;

  for (const x of xs) {
    if (bucket.length > 0 && x - prev > colGap) {
      centers.push(bucket.reduce((s, v) => s + v, 0) / bucket.length);
      bucket = [];
    }
    bucket.push(x);
    prev = x;
  }
  if (bucket.length > 0) centers.push(bucket.reduce((s, v) => s + v, 0) / bucket.length);
  return centers;
}

function nearestColumn(x: number, centers: number[]): number {
  let best = 0;
  let bestDist = Infinity;
  centers.forEach((c, i) => {
    const d = Math.abs(x - c);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

const escapeCell = (s: string) => s.replace(/\|/g, "\\|").trim();

/** Render one segment of rows into a markdown table given its column anchors. */
function renderTable(rows: OcrWord[][], columns: number[]): string {
  const grid = rows.map((row) => {
    const cells = Array<string>(columns.length).fill("");
    for (const w of row) {
      const col = nearestColumn(w.x0, columns);
      cells[col] = cells[col] ? `${cells[col]} ${w.text}` : w.text;
    }
    return cells.map(escapeCell);
  });

  const header = grid[0]!;
  const body = grid.slice(1);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}

const rowAsText = (row: OcrWord[]) => row.map((w) => w.text).join(" ");

/** Render an accumulated row segment: a markdown table when it is table-shaped
 *  (enough rows AND columns), otherwise its rows as plain text. */
function renderSegment(segment: OcrWord[][], colGap: number, opts: ReconstructOptions): string {
  const columns = detectColumns(segment, colGap);
  const isTable = segment.length >= opts.minTableRows && columns.length >= opts.minColumns;
  return isTable ? renderTable(segment, columns) : segment.map(rowAsText).join("\n");
}

/** A pending run of sparse rows is a CONTINUATION of the open table — not the start
 *  of a new one — when appending the next tabular row leaves the table's column
 *  count unchanged (e.g. a stop's phone number floating between two stop rows). */
function pendingRunContinuesTable(segment: OcrWord[][], nextRow: OcrWord[], colGap: number): boolean {
  return detectColumns(segment, colGap).length === detectColumns([...segment, nextRow], colGap).length;
}

/**
 * Group clustered rows into rendered blocks. Tabular rows (≥ minColumns words)
 * accrete into a table segment; sparse rows are held `pending` until the next
 * tabular row reveals whether they continue the open table or a new block begins.
 */
function buildBlocks(rows: OcrWord[][], colGap: number, opts: ReconstructOptions): string[] {
  const blocks: string[] = [];
  let segment: OcrWord[][] = [];
  let pending: OcrWord[][] = [];

  for (const row of rows) {
    if (row.length < opts.minColumns) {
      if (segment.length === 0) blocks.push(rowAsText(row)); // heading — no open table
      else pending.push(row); // hold until the next tabular row tells us its role
      continue;
    }
    if (segment.length > 0 && pending.length > 0) {
      if (pendingRunContinuesTable(segment, row, colGap)) {
        segment.push(...pending); // interstitial continuations of the same table
      } else {
        blocks.push(renderSegment(segment, colGap, opts)); // different table starts
        for (const r of pending) blocks.push(rowAsText(r));
        segment = [];
      }
      pending = [];
    }
    segment.push(row);
  }

  if (segment.length > 0) blocks.push(renderSegment(segment, colGap, opts));
  for (const r of pending) blocks.push(rowAsText(r));
  return blocks;
}

export function reconstructMarkdown(words: OcrWord[], opts: ReconstructOptions): string {
  const kept = words.filter((w) => w.text.trim() !== "" && w.confidence >= opts.minConfidence);
  if (kept.length === 0) return "";

  const medianHeight = median(kept.map((w) => w.y1 - w.y0)) || 1;
  const rows = clusterRows(kept, opts.rowGapFactor * medianHeight);
  const colGap = opts.colGapFactor * medianHeight;

  return buildBlocks(rows, colGap, opts).join("\n\n");
}
