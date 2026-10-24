/**
 * Procurement: obtain one resource from the cheapest admissible source.
 *
 * Free sources are tried first. Paid x402 sources are quoted unsigned
 * (`readHttpPurchaseQuote`), sorted by quoted amount, and bought through
 * `purchaseHttpResource` with the accepted quote, so the existing drift and
 * payee checks apply to every purchase. A per-call ceiling caps every quote.
 * A failed source falls through to the next only when nothing was charged:
 * a charge without delivery stops procurement, so one need is never paid
 * twice. Every outcome is handed to `record` as one cost row for the buyer's
 * own books.
 */

const AMOUNT = /^(0|[1-9][0-9]*)$/u;

const lower = (a, b) => (BigInt(a) < BigInt(b) ? a : b);

/**
 * `candidates`: `[{ url, method?, body?, headers?, free: true }]` or paid
 * `[{ url, method?, body?, headers?, network?, asset?, expectedPayTo, maximumAmount? }]`.
 * `ceiling`: `{ network, asset, maximumAmount }`, atomic units per call.
 * Returns `{ source, kind: "free" | "bought", response?, receipt? }`.
 */
export async function procureHttpResource({
  candidates, ceiling, payer, fetchImpl, record = async () => {},
  now = () => new Date().toISOString(), readQuote, purchase, rpcUrl,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) throw new TypeError("at least one procurement candidate is required");
  if (!ceiling || typeof ceiling.maximumAmount !== "string" || !AMOUNT.test(ceiling.maximumAmount)) throw new TypeError("ceiling.maximumAmount must be a nonnegative integer atomic amount");
  // Zero is an absolute cash prohibition, not permission to search for a low-priced purchase.
  const freeOnly = ceiling.maximumAmount === "0";
  if (typeof fetchImpl !== "function") throw new TypeError("an egress-controlled fetchImpl is required");
  const tried = [];
  for (const source of candidates.filter((c) => c.free === true)) {
    let response;
    try {
      response = await fetchImpl(source.url, { method: source.method ?? "GET", body: source.body, headers: source.headers, redirect: "manual" });
    } catch (error) {
      // Transport failures can fall back to another separately admitted free supplier.
      tried.push({ url: source.url, failed: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (response.ok) {
      // Recording and returning accepted output are NOT transport retries: a failed
      // record is an operating error, not permission to silently acquire again.
      await record({ at: now(), kind: "x402-procurement", url: source.url, outcome: "free", amount: "0" });
      return { source, kind: "free", response };
    }
    tried.push({ url: source.url, status: response.status });
    await response.body?.cancel?.();
  }

  if (freeOnly) {
    // No x402 quote, paid dependency import, signer, or paid-network egress is admissible.
    await record({ at: now(), kind: "x402-procurement", outcome: "unprocured", reason: "zero-cash-ceiling", tried });
    const error = new Error("no free source delivered within the zero-cash ceiling");
    error.code = "ZERO_CASH_PROCUREMENT_EXHAUSTED";
    error.tried = tried;
    throw error;
  }

  readQuote ??= (await import("./http-quote.mjs")).readHttpPurchaseQuote;
  purchase ??= (await import("./purchase.mjs")).purchaseHttpResource;
  const quoted = [];
  for (const source of candidates.filter((c) => c.free !== true)) {
    const network = source.network ?? ceiling.network;
    const asset = source.asset ?? ceiling.asset;
    const maximumAmount = source.maximumAmount ? lower(source.maximumAmount, ceiling.maximumAmount) : ceiling.maximumAmount;
    try {
      const quote = await readQuote({ url: source.url, method: source.method, body: source.body, headers: source.headers, network, asset, maximumAmount, expectedPayTo: source.expectedPayTo, fetchImpl });
      quoted.push({ source, quote, network, asset, maximumAmount });
    } catch (error) {
      tried.push({ url: source.url, refused: error.message });
    }
  }
  quoted.sort((a, b) => (BigInt(a.quote.requirement.amount) < BigInt(b.quote.requirement.amount) ? -1 : 1));

  for (const { source, quote, network, asset, maximumAmount } of quoted) {
    try {
      const receipt = await purchase({
        url: source.url, method: source.method, body: source.body, headers: source.headers,
        payer, network, asset, maximumAmount, expectedPayTo: source.expectedPayTo, acceptedQuote: quote, fetchImpl, rpcUrl,
      });
      await record({ at: now(), kind: "x402-procurement", url: source.url, outcome: "bought", network, asset, amount: quote.requirement.amount, payTo: quote.requirement.payTo, transaction: receipt?.transaction ?? null });
      return { source, kind: "bought", receipt };
    } catch (error) {
      if (error.receipt) {
        await record({ at: now(), kind: "x402-procurement", url: source.url, outcome: "charged-undelivered", network, asset, amount: quote.requirement.amount, payTo: quote.requirement.payTo, transaction: error.receipt.transaction ?? null });
        throw error;
      }
      tried.push({ url: source.url, failed: error.message });
    }
  }

  await record({ at: now(), kind: "x402-procurement", outcome: "unprocured", tried });
  const error = new Error("no admissible source delivered the resource within the ceiling");
  error.tried = tried;
  throw error;
}
