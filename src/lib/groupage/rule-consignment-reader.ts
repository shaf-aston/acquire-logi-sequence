/**
 * Rule-based roster reader: parses the STRUCTURED collection-run table off a groupage
 * manifest with no LLM, no key, and no network (see collection-run-parser.ts). A groupage
 * manifest states its load in a clean `Pallets` column — exactly what a rule pass reads
 * reliably — so this handles the common structured case offline and, crucially, can't be
 * knocked out by a dead API key.
 *
 * When the document has NO collection-run table (a freeform manifest the label pass can't
 * split into companies), it returns whatever an optional `fallback` engine reads — the LLM
 * roster reader, for the judgement a regex pass genuinely can't do. With no fallback it is
 * honestly empty (never a guessed company onto a shared truck). This mirrors the durability
 * classifier's engine-with-fallback chain.
 */
import { createLogger } from "@/lib/logger/logger";
import { parseCollectionRunRoster } from "@/lib/groupage/collection-run-parser";
import { loadGroupageRates } from "@/lib/groupage/groupage-rates";
import type { ConsignmentReader, ConsignmentRoster } from "@/lib/groupage/consignment-reader.types";
import { EMPTY_ROSTER } from "@/lib/groupage/consignment-reader.types";
import type { StructuredDocument } from "@/lib/conversion/types";
// Reuse the SAME validated loader the 3D stacker uses (stack-service.ts) rather than trusting
// the raw JSON import — a missing/zero footprintClasses.oversize.lengthMm here would silently
// classify every pallet as oversize (or none), doubling (or halving) truck space and price.
import { loadPalletSpec } from "@/lib/groupage/stack-service";

const MM_PER_CM = 10;

const logger = createLogger("groupage.consignment-reader.rule");

export interface RuleConsignmentReaderOptions {
  /** Engine to consult when the document has no structured collection-run table. */
  readonly fallback?: ConsignmentReader;
}

export class RuleConsignmentReader implements ConsignmentReader {
  readonly provider = "rule";

  constructor(private readonly options: RuleConsignmentReaderOptions = {}) {}

  async read(document: StructuredDocument): Promise<ConsignmentRoster> {
    // The doubtful-weight ceiling is a config knob (config/groupage-rates.json), read here at the
    // reader boundary so the pure parser stays config-free. Fail-soft: a bad rates file must not
    // knock out the offline reader, so fall back to the parser's own default on any load error.
    let maxPlausibleDerivedPalletKg: number | undefined;
    try {
      maxPlausibleDerivedPalletKg = (await loadGroupageRates()).maxPlausibleDerivedPalletKg;
    } catch (err) {
      logger.warn("couldn't load groupage rates for the doubtful-weight ceiling — using the default", {
        error: String(err),
      });
    }
    // config/pallet-spec.json's oversize footprint IS the threshold — a pallet whose base
    // side reaches this size is exactly what the config calls oversize (see collection-run-parser's
    // `>=` fix: an equal-not-greater side used to bill as standard and take one truck space instead
    // of two). loadPalletSpec() fails loud if the config is missing/invalid — never a silent 0/NaN.
    const oversizeSideCm = loadPalletSpec().footprintClasses.oversize.lengthMm / MM_PER_CM;
    const roster = parseCollectionRunRoster(document, { maxPlausibleDerivedPalletKg, oversizeSideCm });
    if (roster.consignments.length > 0) {
      logger.info("rule reader parsed a collection run", { consignments: roster.consignments.length });
      return roster;
    }

    if (this.options.fallback) {
      logger.info("no collection-run table found — delegating to fallback reader", {
        fallback: this.options.fallback.provider,
      });
      return this.options.fallback.read(document);
    }

    logger.info("no collection-run table found and no fallback configured — empty roster");
    return EMPTY_ROSTER;
  }
}
