# Where we are, and where to go next

Plain-language read on the review campaign — what got checked, what got fixed, what's
left, and the bigger ideas worth thinking about. No jargon; skim the headers.

---

## 1. The headline

I put the whole codebase through a deep, multi-agent review — every finding was then
**challenged by two independent checkers** before it counted, so what's below is the
survivors, not guesses.

**The core is sound.** The parts that turn a PDF into a price — reading the table,
working out the 3D packing, choosing the van, pricing the miles, the groupage hub maths —
had **no serious (critical or high) defects**. That's the important result: the engine
you're quoting real money on is doing the maths right.

What we found were smaller honesty-and-safety gaps: places where the software could
quietly drop something instead of telling you. Those are exactly the ones worth closing,
because a silent wrong answer is worse than a loud "I can't".

---

## 2. What got done this pass

**Reviewed and tidied your in-progress work** (the single-interface line of work): 13 issues
found and fixed, each double-checked. The notable ones:
- The shared-truck backup brain (SambaNova) now uses **its own key against its own
  service** — no risk of the wrong key going to the wrong place.
- The groupage address box now only shows the green tick for a **real postcode** — before,
  a full address like "Coventry, West Midlands" could pass the tick and then fail (or
  quietly price the wrong hub). Now it can't.
- Map zoom, capacity messages, and the 3D unplace behaviour all made more honest.

**Built the safety net that was missing.** The front half of the pipeline — reading the
PDF, splitting the table, validating the upload, finding addresses — had **zero tests**.
It now has 42, plus **10 synthetic test PDFs** covering the real-world awkward cases
(centimetre tables, metre tables, multi-page, missing sizes, mixed units, junk rows,
collection+delivery addresses, multi-drop). And a **keyless end-to-end test** that runs a
real PDF through the real reader (no paid API needed) and checks the sizes, quantities and
addresses come out right. This is your "prove it actually works" button — anyone can run
`npm run test:e2e`.

**Fixed the safe, high-value review findings** (see §3 for what I deliberately left):
- **Silent cargo drop → now loud.** If an order is too big for the vans you own, the
  software used to place what it could and *silently forget the rest* — and the quote only
  charged for what fit. It now reports exactly what was left behind and why ("add vans or
  split the order"). This was the most important fix: it stops an under-price on a job you
  can't actually carry.
- **Route lookups are now cached properly**, so re-pricing the same trip doesn't re-bill
  Google every time.
- **The direct-pack test endpoint now validates its input** and respects the size cap,
  like the main one already did.
- **Dropped the over-eager "to"/"from" address words** that were matching ordinary
  sentences and inventing phantom addresses.

---

## 3. What I deliberately did NOT do (and why)

You said don't over-engineer — so these are **flagged, not forced**. Each is real but
either lives in a file your other work is actively changing, or isn't worth the risk right
now.

| Thing | Why it's parked | When to do it |
|-------|-----------------|---------------|
| **Split the 2,200-line main screen file** | It works, and your quote-send/consolidation work is editing it right now. Splitting it mid-change would cause conflicts. | Once that feature settles — then break it into upload / quote / groupage / admin pieces behind the browser tests. |
| **Multi-page table that skips its header loses rows** | Rare (most PDFs repeat the header per page) and needs a real sample PDF to fix safely. | If a real customer manifest ever loses rows — carry the previous page's header forward. |
| **Map embed key shown to the browser** | The proper fix needs *you* to make a second, restricted Google key. | Make a browser-only, website-locked Maps key and point the embed at it. 10-minute job in the Google console. |
| **Address reader edge cases** (a line with both a From and a To, a stray postcode after a label) | The address file is one your other work touched, and these are on the *operator-reviewed* prefill — you'd catch them. | Bundle with a proper address-reader hardening pass later. |
| **Warn at the quote step if items didn't fit** | Small UI touch on the hot main-screen file. | Add a one-line banner when the quote excludes unplaced items. |

None of these are blockers. They're the honest backlog.

---

## 4. One thing worth checking: your new features aren't reviewed yet

While the review ran, a **consolidation** feature (grouping small units into blocks) and a
**send-quote-to-customer / email** feature appeared in the project. Those are **not part of
what I reviewed or tested** — they came in separately. When you're ready, they deserve the
same treatment: the multi-agent review + tests, especially the consolidation packing maths
(it changes how the van gets filled, so it can move the price) and the email path (anything
that sends outside the building needs its input checked and its key kept server-side).

---

## 5. The bigger ideas — thinking outside the box

You asked what you might be missing. Here's the honest list, most important first.

### 5a. The logistics model you may be missing: **pallet-network / partner LTL**
Right now "shared truck" (groupage) means **your own hubs and your own trunk**. But the way
most asset-based 3PLs actually move less-than-a-full-load freight is by **injecting it into
a pallet network they're a member of** (Palletways, Pallet-Track, Fortec, etc.). You hand
the pallet to the network at your local depot; the network's overnight trunk + partner
depots do the rest. You don't run the middle leg at all.

**Why this might be the big miss:** your current groupage assumes *you* own hub-to-hub. An
asset-based 3PL that isn't big enough to run a national trunk every night usually **buys
that leg from a network** and marks it up. If your customer is one of those, "groupage via
my own hubs" is the wrong model and "book a pallet on the network, price = network rate +
my first/last mile + margin" is the right one. It's a small addition — it reuses your hub
resolve and your pallet-count maths; only the middle-leg price source changes (a network
rate card instead of your own trunk rate). **Worth a 20-minute conversation before building
more of the own-hub trunk.**

### 5b. Backloads / empty-return matching
Every quote is priced on its own. But a van that just dropped a load is about to drive home
empty — filling that return leg is found money. A simple version: keep a list of "van will
be empty here, around then", and when a new quote roughly matches a return corridor, offer a
discounted backload price. High commercial value, moderate build.

### 5c. Show the customer, not just the operator
The 3D load view and the quote are gorgeous internally. A **shareable, read-only quote link**
(customer sees the price, the van fill, the route map, and an accept button) turns the tool
into a sales asset. The quote-send feature that just appeared is the first step of this —
worth finishing deliberately.

### 5d. CO₂ per quote
Tenders increasingly *require* a carbon figure. You already compute the miles and the van —
adding grams-CO₂-per-mile per van type to the config gives you a carbon line on every quote
almost for free. Cheap, and it wins the kind of contracts that ask for it.

### 5e. Let the reader learn from corrections
When an operator fixes a mis-read row (wrong size, wrong material), that correction is
currently thrown away. Capturing it — even as a simple "if this supplier's PDF, this column
means X" memory — makes the reader get better at *your* customers' specific formats over
time. Compounding accuracy, low effort to start.

---

## 6. Suggested order

1. **Have the pallet-network conversation (5a).** It might change what "groupage" should be —
   cheapest to fix now, most expensive to fix after more own-hub trunk is built.
2. Review + test the new consolidation and quote-send features (§4).
3. Make the browser-locked Maps key (§3) — quick and closes a real key-exposure.
4. Finish the customer-facing quote link (5c) — turns the tool into a sales weapon.
5. CO₂ line (5d) — cheap, opens doors.
6. Backloads (5b) and the learning reader (5e) when there's appetite for bigger builds.

---

*Everything in §2 that says "fixed" is saved and test-covered. Everything in §3 and §5
is a choice, not a debt you're carrying unknowingly — which was the point of the review.*
