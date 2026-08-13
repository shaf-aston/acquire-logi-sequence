/**
 * The canonical cargo-row identity: `${pageIndex}-${tableIndex}-${rowIndex}`. Kept in its own
 * dependency-free leaf so both server code (stop-attributor, item-assembler) and the client
 * (the collection per-stop view) share ONE definition without dragging in config/fs. A
 * `Placement.itemId` equals this string (a consolidated block appends a `::block` suffix).
 */
export function rowId(pageIndex: number, tableIndex: number, rowIndex: number): string {
  return `${pageIndex}-${tableIndex}-${rowIndex}`;
}
