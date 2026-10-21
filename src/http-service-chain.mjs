import { createHash } from "node:crypto";

// Buyer-owned bounded execution of original seller contracts.
// The source seller's JSON Schema and field projection remain upstream.
const UINT256 = (1n << 256n) - 1n;
const AMOUNT = /^(0|[1-9][0-9]*)$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const CAIP = /^eip155:[1-9][0-9]*$/u;
const MAX_CELLS = 8;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function atomic(value, field, positive = false) {
  if (typeof value !== "string" || !AMOUNT.test(value) || value.length > 78) {
    throw new TypeError(`${field} must be a canonical EVM atomic amount`);
  }
  const count = BigInt(value);
  if (count > UINT256 || (positive && count === 0n)) {
    throw new RangeError(`${field} exceeds admitted EVM atomic bounds`);
  }
  return count;
}

function jsonSnapshot(value, field) {
  let string;
  try { string = JSON.stringify(value); } catch { /* refused below */ }
  if (typeof string !== "string") throw new TypeError(`${field} must be a JSON value`);
  let result;
  try { result = JSON.parse(string); } catch { throw new TypeError(`${field} must be a JSON value`); }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return result;
}

function admitValidation(answer, boundary) {
  if (answer !== true && answer?.valid !== true)
    throw new TypeError(`${boundary} rejected the original source contract`);
}

function parsePaidJson(receipt, { maximumResponseBytes }) {
  if (receipt?.settlementMatchesRequirements !== true || !receipt.delivery ||
      receipt.delivery.ok !== true || !Number.isSafeInteger(receipt.status) ||
      receipt.status < 200 || receipt.status >= 300) {
    throw new TypeError("x402 settlement report and successful delivered result are required");
  }
  const representation = receipt.delivery;
  const contentType = representation.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json"))
    throw new TypeError("paid service result must be JSON for a typed handoff");
  if (representation.encoding !== "base64" || typeof representation.body !== "string" ||
      representation.body.length > Math.ceil(maximumResponseBytes / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(representation.body)) {
    throw new TypeError("paid JSON result must carry bounded canonical base64 bytes");
  }
  const bytes = Buffer.from(representation.body, "base64");
  if (bytes.length > maximumResponseBytes ||
      bytes.toString("base64") !== representation.body ||
      representation.bytes !== bytes.length ||
      representation.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw new TypeError("paid JSON bytes do not match their original delivered digest and size");
  }
  let decoded;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new TypeError("paid JSON result cannot be strictly decoded"); }
  return jsonSnapshot(decoded, "paid source result");
}

function stageSnapshot(stage, index) {
  const offer = jsonSnapshot(stage?.offer, `cell ${index} offer`);
  const authority = jsonSnapshot(stage?.authority, `cell ${index} owner authority`);
  if (offer.listed !== true || offer.method !== "POST" ||
      typeof offer.sku !== "string" || offer.sku.length < 1 || offer.sku.length > 512 ||
      typeof offer.url !== "string" || typeof offer.request?.bodySchema !== "object" ||
      typeof offer.output?.schema !== "object") {
    throw new TypeError(`cell ${index} must name an original listed POST offer with typed input/output`);
  }
  const endpoint = new URL(offer.url);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash ||
      /\{[^}]+\}/u.test(offer.url))
    throw new TypeError(`cell ${index} requires a concrete original HTTPS resource`);
  const expectedPayTo = typeof authority.expectedPayTo === "string"
    ? authority.expectedPayTo.toLowerCase() : "";
  if (!ADDRESS.test(expectedPayTo))
    throw new TypeError(`cell ${index} requires an independently authorized expectedPayTo`);
  const maximum = atomic(authority.maximumAmount, `cell ${index} maximumAmount`, true);
  if (Object.keys(authority).some(key => !["expectedPayTo", "maximumAmount", "acceptedQuote"].includes(key)))
    throw new TypeError(`cell ${index} owner authority contains an unsupported claim`);
  return Object.freeze({ offer, authority: Object.freeze({
    maximumAmount: authority.maximumAmount,
    expectedPayTo,
    ...(authority.acceptedQuote === undefined ? {} : { acceptedQuote: authority.acceptedQuote }),
  }), maximum });
}

// A buyer-delegated finite Hoare program: each service has independent
// owner-admitted payment preconditions, original typed IO, separate receipts,
// and observed delivery postconditions. Accepted Work belongs to AOE.
// Caller MUST supply actual x402 buyer, upstream projection, original JSON
// Schema validators, egress/wallet and DURABLE journals. No automatic retry.
export async function executeHttpServiceChain({
  stages, initialBody, network, asset, payer, maximumTotalAtomic,
  purchaseHttpResource, projectMarketOfferBody, validateInput, validateOutput,
  fetchImpl, beforePayment, onSettlement, onDelivery, onStage,
  maximumResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (!Array.isArray(stages) || stages.length < 2 || stages.length > MAX_CELLS)
    throw new TypeError("service chain requires two to eight original payable cells");
  if (!CAIP.test(network ?? "") || !ADDRESS.test(asset?.toLowerCase() ?? "") ||
      payer?.network !== network || typeof payer?.caip10 !== "string" ||
      typeof fetchImpl !== "function")
    throw new TypeError("service chain requires one wallet-bound denomination and owner-controlled egress");
  if ([purchaseHttpResource, projectMarketOfferBody, validateInput, validateOutput]
    .some(callback => typeof callback !== "function")) {
    throw new TypeError("service chain requires the original buyer and source schema/projection capabilities");
  }
  if ([beforePayment, onSettlement, onDelivery, onStage]
    .some(callback => typeof callback !== "function")) {
    throw new TypeError("service chain requires the owner's private payment, settlement, delivery and cell journals");
  }
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1 ||
      maximumResponseBytes > MAX_RESPONSE_BYTES)
    throw new TypeError("service chain response budget is out of bounds");
  const ceiling = atomic(maximumTotalAtomic, "maximumTotalAtomic", true);
  const cells = stages.map(stageSnapshot);
  const allMaximum = cells.reduce((total, cell) => total + cell.maximum, 0n);
  if (allMaximum > ceiling) {
    throw new RangeError("sum of independently authorized cell maxima exceeds total chain budget");
  }
  let body = jsonSnapshot(initialBody, "first cell input");
  admitValidation(await validateInput(cells[0].offer, body), "first cell input");
  const completed = [];
  const receipts = [];
  let reportedSpend = 0n;
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index];
    let receipt;
    try {
      admitValidation(await validateInput(cell.offer, body), `cell ${index} input`);
      receipt = await purchaseHttpResource({
        url: cell.offer.url,
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body,
        payer, network, asset,
        maximumAmount: cell.authority.maximumAmount,
        expectedPayTo: cell.authority.expectedPayTo,
        ...(cell.authority.acceptedQuote === undefined ? {} : {
          acceptedQuote: cell.authority.acceptedQuote,
        }),
        fetchImpl, maximumResponseBytes,
        beforePayment: reading => beforePayment(index, cell.offer, reading),
        onSettlement: reading => onSettlement(index, cell.offer, reading),
        onDelivery: reading => onDelivery(index, cell.offer, reading),
      });
      // Retain paid-but-malformed results; payment may have happened.
      receipts.push(receipt);
      const requirement = receipt?.requirement;
      if (receipt?.request?.url !== new URL(cell.offer.url).href ||
          receipt.request.method !== "POST" ||
          requirement?.network !== network ||
          requirement?.asset?.toLowerCase() !== asset.toLowerCase() ||
          requirement?.payTo?.toLowerCase() !== cell.authority.expectedPayTo) {
        throw new TypeError("paid cell receipt contradicts the authorized original offer or payee");
      }
      const amount = atomic(requirement.amount, `cell ${index} received x402 amount`, true);
      if (amount > cell.maximum || reportedSpend + amount > ceiling)
        throw new RangeError("paid cell receipt contradicts the chain budget");
      reportedSpend += amount;
      const output = parsePaidJson(receipt, { maximumResponseBytes });
      admitValidation(await validateOutput(cell.offer, output), `cell ${index} output`);
      const observation = Object.freeze({
        index, sku: cell.offer.sku,
        sourceSeller: cell.offer.seller?.enterprise ?? null,
        sourceSection: cell.offer.section ?? null,
        payTo: cell.authority.expectedPayTo,
        reportedAmountAtomic: amount.toString(),
        deliveredSha256: receipt.delivery.sha256,
        deliveredBytes: receipt.delivery.bytes,
        settlement: "matching-facilitator-report-not-independent-chain-proof",
        independentlyAcceptedWork: null,
      });
      completed.push(observation);
      await onStage(observation, receipt);
      if (index === cells.length - 1) {
        return Object.freeze({
          type: "X402HoareServiceChainDelivery",
          network, asset, maximumTotalAtomic, reportedSpendAtomic: reportedSpend.toString(),
          cells: Object.freeze(completed), purchasedReceipts: Object.freeze(receipts),
          result: output, independentlyAcceptedWork: null,
        });
      }
      const projected = await projectMarketOfferBody(cell.offer, cells[index + 1].offer, output);
      if (projected?.from !== cell.offer.sku || projected?.to !== cells[index + 1].offer.sku ||
          projected?.paymentAuthorized !== false || projected?.executionAuthorized !== false) {
        throw new TypeError("upstream x402 typed handoff lacks original identity/refusal witness");
      }
      body = jsonSnapshot(projected.body, `cell ${index + 1} handoff`);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.chainProgress = Object.freeze({
        failedIndex: index, failedSku: cell.offer.sku,
        reportedSpendAtomic: reportedSpend.toString(),
        completed: Object.freeze([...completed]),
        purchasedReceipts: Object.freeze([...receipts]),
        uncertainReceipt: error.receipt ?? null,
        retryAutomatically: false,
      });
      throw error;
    }
  }
}
