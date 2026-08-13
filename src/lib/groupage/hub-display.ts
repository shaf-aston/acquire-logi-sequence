/**
 * Presentation helpers for hub names / catchments — shared by the groupage journey strip
 * (customer-facing) and the network mini-map. Pure string formatting, no domain logic.
 */

/**
 * Hub names carry a region suffix for the picker UI ("Leeds (Yorkshire & North East)").
 * Strip it for compact display and ellipsize anything still long. `maxLen` lets the SVG
 * map (tight width) ask for a shorter cut than the roomier journey strip.
 */
export function hubTown(name: string, maxLen = 18): string {
  const short = name.split(" (")[0] ?? name;
  return short.length > maxLen ? `${short.slice(0, maxLen)}…` : short;
}

/**
 * Plain-language summary of a hub's catchment prefixes for the "what is this hub" note:
 * "BS, BA, GL +4 more". Never invents areas — an empty catchment says so plainly.
 */
export function catchmentSummary(catchment: readonly string[], shown = 3): string {
  if (catchment.length === 0) return "no postcode areas set";
  const head = catchment.slice(0, shown).join(", ");
  const rest = catchment.length - shown;
  return rest > 0 ? `${head} +${rest} more` : head;
}
