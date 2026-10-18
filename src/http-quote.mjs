/**
 * A bounded signer-free x402 v2 quote, and the ONE pure acceptance selector
 * shared by inspection and paid execution. This is the buyer-side commerce
 * boundary, downstream of the Mark/Sign* mathematics; no wallet or ledger.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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


/**
 * The one canonical, bounded request construction shared by quote inspection
 * and executed purchases. Network access and signer authority are NOT here.
 */
export function prepareHttpResourceRequest({ url, method = "GET", body, headers = {} } = {}) {
  const resource = resourceUrl(url);
  if (!METHODS.has(method) || (["GET", "HEAD"].includes(method) && body !== undefined)) {
    throw new TypeError("one HTTP method and a compatible request body are required");
  }
  const requestHeaders = Object.fromEntries(new Headers(headers));
  if (["payment-signature", "x-payment", "host"].some(name => name in requestHeaders)) {
    throw new TypeError("request headers cannot carry an ambient payment signature or Host override");
  }
  const serialized = body === undefined ? undefined
    : typeof body === "string" ? body : JSON.stringify(body);
  if (body !== undefined && typeof body !== "string" && !requestHeaders["content-type"]) {
    requestHeaders["content-type"] = "application/json";
  }
  // Hash the complete caller-supplied representation selector, without
  // publishing potentially private header values in quote or payment receipts.
  // Headers() canonicalizes casing; sorting makes insertion order irrelevant.
  const canonicalHeaders = Object.entries(requestHeaders)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const request = Object.freeze({
    url: resource.href, method,
    bodySha256: createHash("sha256").update(serialized ?? "").digest("hex"),
    headersSha256: createHash("sha256").update(JSON.stringify(canonicalHeaders)).digest("hex"),
  });
  return { resource, requestHeaders, serialized, request };
}

/**
 * An observed unsigned quote is a constraint selected by the enterprise owner,
 * never spending authority. A later 402 must reproduce the exact terms before
 * a signing capability is exercised. This is not a signed merchant commitment.
 */
export function assertQuotedPurchase(quote, {
  request, requirement, maximumAmount, expectedPayTo,
} = {}) {
  const matches = quote?.type === "X402HttpQuote"
    && isDeepStrictEqual(quote.request, request)
    && quote.maximumAmount === maximumAmount
    && quote.expectedPayTo === expectedPayTo
    && (requirement === undefined || isDeepStrictEqual(quote.requirement, requirement));
  if (!matches) {
    const error = new Error("observed x402 quote differs from the owner-admitted purchase");
    error.code = "X402_QUOTE_DRIFT";
    throw error;
  }
  return true;
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
export function admitOwnerTerms({ network, asset, maximumAmount, expectedPayTo } = {}) {
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
export async function readHttpPurchaseTerms({
  url, method = "GET", body, headers = {}, network, asset, maximumAmount,
  expectedPayTo, fetchImpl, httpClient, signal,
} = {}) {
  const { resource, requestHeaders, serialized, request } =
    prepareHttpResourceRequest({ url, method, body, headers });
  if (typeof fetchImpl !== "function") throw new TypeError("quote requires an owner-controlled egress-safe fetchImpl");
  // Validate owner constraints BEFORE the first network request.
  admitOwnerTerms({ network, asset, maximumAmount, expectedPayTo });
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
  const quote = Object.freeze({
    type: "X402HttpQuote",
    request,
    requirement: Object.freeze(requirement),
    maximumAmount,
    ...(expectedPayTo === undefined ? {} : { expectedPayTo: expectedPayTo.toLowerCase() }),
    authority: Object.freeze({
      paymentAttempted: false, signingAttempted: false,
      settlementObserved: false, deliveryObserved: false,
    }),
  });
  // A durable purchaser needs the validated *original* server challenge for
  // the official EVM signer. This is still an UNSIGNED, untrusted merchant
  // observation; the independently admitted owner's quote constrains the
  // unique eligible network, token, payee and maximum amount. The paid HTTP
  // send and its recovery remain distinct effects.
  return Object.freeze({ quote, paymentRequired: structuredClone(validatePaymentRequired(required)) });
}

/** One signer-free quote for UIs, MCP actors and budget previews. The same
 * source read also serves recoverable buyers which need the original v2
 * challenge to construct the official payment authorization. */
export async function readHttpPurchaseQuote(options = {}) {
  const { quote } = await readHttpPurchaseTerms(options);
  return quote;
}
