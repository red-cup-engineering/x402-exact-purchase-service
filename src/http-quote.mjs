/**
 * A bounded signer-free x402 v2 quote, and the ONE pure acceptance selector
 * shared by inspection and paid execution. This is the buyer-side commerce
 * boundary, downstream of the Mark/Sign* mathematics; no wallet or ledger.
 */
import { createHash } from "node:crypto";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { validatePaymentRequired } from "@x402/core/schemas";

const NETWORK = /^eip155:[1-9][0-9]*$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const AMOUNT = /^[1-9][0-9]*$/u;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

function resourceUrl(value) {
  if (typeof value !== "string" || value.length > 4096) {
    throw new TypeError("x402 quote needs one bounded absolute HTTPS URL");
  }
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("x402 quote needs an HTTPS URL without credentials or fragment");
  }
  return url;
}

/** A URI match, not a claim that the priced body has been delivered. */
export function challengeNamesResource(required, url) {
  const resource = resourceUrl(url);
  return required?.resource?.url === resource.href
    || required?.resource?.url === `${resource.origin}${resource.pathname}`;
}

/**
 * Exactly one offer must match the owner's explicit network, asset, ceiling
 * and (when independently known) recipient. Never choose the cheapest among
 * ambiguous alternatives, and never let a server increase the buyer's budget.
 */
function admitOwnerTerms({ network, asset, maximumAmount, expectedPayTo } = {}) {
  if (!NETWORK.test(network ?? "")) throw new TypeError("network must be one explicit EIP-155 CAIP-2 identifier");
  if (!AMOUNT.test(maximumAmount ?? "")) throw new TypeError("maximumAmount must be a positive integer atomic amount");
  const token = typeof asset === "string" ? asset.toLowerCase() : "";
  if (!ADDRESS.test(token)) throw new TypeError("asset must explicitly name an EVM token");
  const payee = typeof expectedPayTo === "string" ? expectedPayTo.toLowerCase() : undefined;
  if (expectedPayTo !== undefined && !ADDRESS.test(payee ?? "")) {
    throw new TypeError("expectedPayTo must be an independently authorized EVM address");
  }
  return Object.freeze({ network, token, maximumAmount, payee });
}

export function selectExactPaymentRequirement(required, {
  network, asset, maximumAmount, expectedPayTo,
} = {}) {
  if (required?.x402Version !== 2) throw new TypeError("one official x402 v2 challenge is required");
  // Use the SDK's complete wire schema: a plausible price without the
  // protocol's timeout/resource fields is not an admissible quote.
  const parsed = validatePaymentRequired(required);
  const { token, payee } = admitOwnerTerms({ network, asset, maximumAmount, expectedPayTo });
  const accepted = parsed.accepts;
  const eligible = accepted.filter(candidate =>
    candidate?.scheme === "exact"
    && candidate.network === network
    && typeof candidate.asset === "string" && candidate.asset.toLowerCase() === token
    && typeof candidate.payTo === "string" && ADDRESS.test(candidate.payTo.toLowerCase())
    && (payee === undefined || candidate.payTo.toLowerCase() === payee)
    && typeof candidate.amount === "string" && AMOUNT.test(candidate.amount)
    && BigInt(candidate.amount) <= BigInt(maximumAmount));
  if (eligible.length !== 1) throw new Error("resource did not offer exactly one admitted exact-EVM payment requirement");
  return structuredClone(eligible[0]);
}

/**
 * Pure comparison of a facilitator's claimed settlement to owner-admitted
 * exact-EVM terms. A report can OMIT some fields, but can never contradict the
 * selected network, token, amount, recipient or independently known payer.
 * This comparison is NOT an independent on-chain receipt or delivered work.
 * Reuse it in one-shot HTTP buying and in owners' durable recovery paths.
 */
export function matchesExactPaymentSettlementReport(report, {
  network, asset, amount, payTo, payer,
} = {}) {
  const token = typeof asset === "string" ? asset.toLowerCase() : "";
  const recipient = typeof payTo === "string" ? payTo.toLowerCase() : "";
  const purchaser = typeof payer === "string" ? payer.toLowerCase() : undefined;
  if (!NETWORK.test(network ?? "") || !ADDRESS.test(token) || !AMOUNT.test(amount ?? "")
      || !ADDRESS.test(recipient) || (payer !== undefined && !ADDRESS.test(purchaser))) {
    return false;
  }
  const optionalAddressMatches = (observed, expected) => observed === undefined ||
    (typeof observed === "string" && ADDRESS.test(observed.toLowerCase())
      && (expected === undefined || observed.toLowerCase() === expected));
  return report?.success === true
    && report.network === network
    && typeof report.transaction === "string"
    && /^0x[0-9a-f]{64}$/u.test(report.transaction.toLowerCase())
    && (report.amount === undefined || report.amount === amount)
    && optionalAddressMatches(report.asset, token)
    && optionalAddressMatches(report.payee, recipient)
    && optionalAddressMatches(report.payTo, recipient)
    && optionalAddressMatches(report.payer, purchaser);
}

/**
 * Inspect a specific method/body's real 402 without opening wallet custody.
 * Caller MUST provide its own egress-controlled fetch capability; no implicit
 * DNS, redirect following, signing, settlement, or purchased response reading.
 * A POST probe is only suitable for an owner's known x402-first endpoint.
 */
export async function readHttpPurchaseQuote({
  url, method = "GET", body, headers = {}, network, asset, maximumAmount,
  expectedPayTo, fetchImpl, httpClient, signal,
} = {}) {
  const resource = resourceUrl(url);
  if (!METHODS.has(method) || (["GET", "HEAD"].includes(method) && body !== undefined)) {
    throw new TypeError("quote requires an explicit HTTP method and compatible body");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("quote requires an owner-controlled egress-safe fetchImpl");
  // Validate owner constraints BEFORE the first network request.
  admitOwnerTerms({ network, asset, maximumAmount, expectedPayTo });
  const requestHeaders = Object.fromEntries(new Headers(headers));
  if (["payment-signature", "x-payment", "host"].some(name => name in requestHeaders)) {
    throw new TypeError("quote cannot carry an ambient payment signature or Host override");
  }
  const serialized = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  if (body !== undefined && typeof body !== "string" && !requestHeaders["content-type"]) {
    requestHeaders["content-type"] = "application/json";
  }
  const response = await fetchImpl(resource.href, {
    method, headers: requestHeaders, body: serialized, redirect: "error",
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  if (response.status !== 402) {
    await response.body?.cancel();
    const error = new Error(`resource returned HTTP ${response.status}, not an x402 quote`);
    error.code = "X402_QUOTE_NOT_REQUIRED";
    error.status = response.status;
    throw error;
  }
  const header = response.headers.get("payment-required");
  if (header === null || header.length === 0 || header.length > 65_536) {
    await response.body?.cancel();
    throw new TypeError("x402 quote requires one bounded payment-required header");
  }
  let required;
  try {
    // The official wire decoder needs no instantiated signer or scheme client.
    required = httpClient === undefined
      ? decodePaymentRequiredHeader(header)
      : httpClient.getPaymentRequiredResponse(name => response.headers.get(name));
  } finally {
    await response.body?.cancel();
  }
  if (!challengeNamesResource(required, resource.href)) {
    throw new TypeError("x402 v2 challenge names a different resource URL");
  }
  const requirement = selectExactPaymentRequirement(required, {
    network, asset, maximumAmount, expectedPayTo,
  });
  return Object.freeze({
    type: "X402HttpQuote",
    request: Object.freeze({
      url: resource.href, method,
      bodySha256: createHash("sha256").update(serialized ?? "").digest("hex"),
    }),
    requirement: Object.freeze(requirement),
    maximumAmount,
    ...(expectedPayTo === undefined ? {} : { expectedPayTo: expectedPayTo.toLowerCase() }),
    authority: Object.freeze({
      paymentAttempted: false, signingAttempted: false,
      settlementObserved: false, deliveryObserved: false,
    }),
  });
}
