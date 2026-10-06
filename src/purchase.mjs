import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  loadSuccessorAccountBinding,
  SuccessorChainMigrationObstruction,
} from "./successor-deployment.mjs";

const CAIP2 = /^eip155:[1-9][0-9]*$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const HASH = /^0x[0-9a-f]{64}$/u;

function exactNetwork(value) {
  if (!CAIP2.test(value ?? "")) throw new TypeError("network must be one explicit EIP-155 CAIP-2 identifier");
  return value;
}

function exactAmount(value, label) {
  if (!POSITIVE_INTEGER.test(value ?? "")) throw new TypeError(`${label} must be a positive integer atomic amount`);
  return value;
}

function requiredSturdyRef(value) {
  if (!/^urn:ocapn:sturdyref:[A-Za-z0-9_-]{43}$/u.test(value ?? "")) {
    throw new TypeError("one canonical OCapN sturdy reference is required");
  }
  return value;
}

export class X402ResourceResponseError extends Error {
  constructor(message, { boundary, status, contentType, bodySha256, cause } = {}) {
    super(message, { cause });
    this.name = "X402ResourceResponseError";
    this.code = "X402_RESOURCE_INVALID_RESPONSE";
    this.boundary = boundary;
    this.status = status;
    this.contentType = contentType;
    this.bodySha256 = bodySha256;
  }
}

export class IncompleteSettlementEvidenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "IncompleteSettlementEvidenceError";
    this.code = "X402_TERMINAL_SETTLEMENT_EVIDENCE_INCOMPLETE";
    this.type = "X402TerminalSettlementEvidenceRefusal";
  }
}

function incomplete(message) {
  throw new IncompleteSettlementEvidenceError(message);
}

function exactJoin(value, label) {
  if (!HASH.test(value?.demand ?? "")) incomplete(`${label}.demand must be one demand content address`);
  if (label !== "result" && !HASH.test(value?.offer ?? "")) {
    incomplete(`${label}.offer must be one offer content address`);
  }
  if (!HASH.test(value?.transactionHash ?? "") || !Number.isSafeInteger(value?.logIndex) || value.logIndex < 0) {
    incomplete(`${label} must name one exact transaction/log coordinate`);
  }
}

export function assertTerminalSettlementEvidence(receipt, terminal) {
  const evidence = terminal?.settlementEvidence;
  if (evidence?.type !== "SemioticExchangeTerminalSettlementEvidence") {
    incomplete("terminal delivery must carry SemioticExchangeTerminalSettlementEvidence");
  }
  const exchange = evidence.exchange;
  if (exchange?.network !== receipt?.exchange?.network
      || exchange?.address?.toLowerCase() !== receipt?.exchange?.address
      || !ADDRESS.test(exchange?.address?.toLowerCase() ?? "")) {
    incomplete("terminal exchange coordinate does not match the admitted successor deployment");
  }
  const joins = evidence.joins;
  if (!HASH.test(joins?.demand ?? "") || !HASH.test(joins?.offer ?? "")
      || !HASH.test(joins?.result?.contentAddress ?? "")) {
    incomplete("terminal evidence requires exact demand, offer, and result content addresses");
  }
  exactJoin(joins.purchase, "purchase");
  exactJoin(joins.result, "result");
  if (joins.purchase.demand !== joins.demand || joins.purchase.offer !== joins.offer
      || joins.result.demand !== joins.demand) {
    incomplete("demand, offer, purchase, and result joins do not commute");
  }
  const consideration = evidence.consideration;
  const requirement = receipt.requirement;
  const payer = receipt.customer?.split(":").at(-1)?.toLowerCase();
  if (consideration?.network !== requirement?.network
      || consideration?.network !== exchange.network
      || consideration?.asset?.toLowerCase() !== requirement?.asset?.toLowerCase()
      || consideration?.amount !== requirement?.amount
      || consideration?.payer?.toLowerCase() !== payer
      || consideration?.payee?.toLowerCase() !== requirement?.payTo?.toLowerCase()
      || !ADDRESS.test(consideration?.asset?.toLowerCase() ?? "")
      || !ADDRESS.test(consideration?.payer?.toLowerCase() ?? "")
      || !ADDRESS.test(consideration?.payee?.toLowerCase() ?? "")
      || !HASH.test(consideration?.transactionHash?.toLowerCase() ?? "")) {
    incomplete("terminal consideration must carry the exact network, asset, amount, payer, payee, and transaction");
  }
  const settlementReceipt = consideration.receipt;
  if (settlementReceipt?.transactionHash?.toLowerCase() !== consideration.transactionHash.toLowerCase()
      || settlementReceipt?.status !== 1
      || !Number.isSafeInteger(settlementReceipt?.blockNumber) || settlementReceipt.blockNumber < 0
      || !HASH.test(settlementReceipt?.blockHash?.toLowerCase() ?? "")) {
    incomplete("terminal consideration must include one successful exact transaction receipt");
  }
  return terminal;
}

async function digestBody(response) {
  const digest = createHash("sha256");
  if (response.body == null) return digest.digest("hex");
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 16 * 1024 * 1024) throw new RangeError("resource response exceeds 16 MiB");
    digest.update(chunk);
  }
  return digest.digest("hex");
}

async function exactJsonResponse(response, boundary) {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw new X402ResourceResponseError(
      `${boundary} returned a non-JSON representation`,
      {
        boundary,
        status: response.status,
        contentType,
        bodySha256: await digestBody(response),
      },
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > 16 * 1024 * 1024) throw new RangeError("resource response exceeds 16 MiB");
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new X402ResourceResponseError(
      `${boundary} returned malformed JSON`,
      {
        boundary,
        status: response.status,
        contentType,
        bodySha256: createHash("sha256").update(text).digest("hex"),
        cause,
      },
    );
  }
}

export async function openEnterpriseAccountPayer({
  deploymentManifestPath,
  accountBindingPath,
  keystorePath,
  passwordFile,
} = {}) {
  const active = await loadSuccessorAccountBinding({
    manifestPath: deploymentManifestPath,
    accountBindingPath,
    nodeId: "x402-exact-purchase-service",
  });
  const binding = active.binding;
  const account = binding?.account?.address?.toLowerCase();
  const policySigner = binding?.policy?.signer?.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(account ?? "") || !/^0x[0-9a-f]{40}$/u.test(policySigner ?? "")) {
    throw new Error("payer binding must name one enterprise account and policy signer");
  }
  let openSettlementSigner;
  try {
    ({ openSettlementSigner } = await import("@red-cup-engineering/enterprise-account-provisioning-service/custody"));
  } catch (cause) {
    throw new SuccessorChainMigrationObstruction(
      "x402-exact-purchase-service requires a provisioner-owned successor policy-signer capability; the predecessor local-custody subpath is not an exported active interface",
      { nodeId: "x402-exact-purchase-service", cause },
    );
  }
  const controller = await openSettlementSigner({ path: keystorePath, passwordFile });
  if (controller.address.toLowerCase() !== policySigner) {
    throw new Error("encrypted custody does not control the enterprise account policy signer");
  }
  return Object.freeze({
    network: active.deployment.chain,
    exchange: active.deployment.exchange,
    deploymentBlock: active.deployment.deploymentBlock,
    rpc: active.deployment.rpc,
    caip10: binding.account.caip10,
    signer: Object.freeze({
      address: account,
      signTypedData: ({ domain, types, message }) => controller.signTypedData(domain, types, message),
    }),
  });
}

/**
 * Buy an ordinary x402 HTTP representation using the customer's signer.
 * No exchange, OCapN reference, host ledger or seller-specific response shape
 * participates in this contract. Hooks let the owning enterprise retain intent
 * before transmission and settlement before reading delivery.
 */
export async function purchaseHttpResource({
  url, method = "GET", body, headers = {}, payer, network, asset, maximumAmount,
  rpcUrl, fetchImpl = globalThis.fetch, httpClient, signal,
  maximumResponseBytes = 16 * 1024 * 1024, beforePayment, onSettlement,
} = {}) {
  const resource = new URL(url);
  if (resource.protocol !== "https:" || resource.username || resource.password || resource.hash) {
    throw new TypeError("resource must be an absolute HTTPS URL without credentials or fragment");
  }
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method)
      || (["GET", "HEAD"].includes(method) && body !== undefined)) {
    throw new TypeError("one HTTP method and a compatible request body are required");
  }
  const selectedNetwork = exactNetwork(network);
  const ceiling = exactAmount(maximumAmount, "maximumAmount");
  const selectedAsset = asset?.toLowerCase();
  if (!ADDRESS.test(selectedAsset ?? "")) throw new TypeError("asset must explicitly name the admitted EVM token");
  const account = payer?.signer?.address?.toLowerCase();
  if (payer?.network !== selectedNetwork || !ADDRESS.test(account ?? "")
      || payer?.caip10?.toLowerCase() !== `${selectedNetwork}:${account}`) {
    throw new TypeError("payer must bind its signer and CAIP-10 account to the admitted network");
  }
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1
      || maximumResponseBytes > 64 * 1024 * 1024) {
    throw new TypeError("maximumResponseBytes must be between 1 and 67108864");
  }
  const requestHeaders = Object.fromEntries(new Headers(headers));
  if (["payment-signature", "x-payment", "host"].some(name => name in requestHeaders)) {
    throw new TypeError("request headers cannot carry an ambient payment signature or host override");
  }
  const serialized = body === undefined ? undefined
    : typeof body === "string" ? body : JSON.stringify(body);
  if (body !== undefined && typeof body !== "string" && !requestHeaders["content-type"]) {
    requestHeaders["content-type"] = "application/json";
  }
  const protocol = httpClient ?? (() => {
    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: payer.signer, networks: [selectedNetwork], schemeOptions: { rpcUrl },
    });
    return new x402HTTPClient(client);
  })();
  const init = { method, headers: requestHeaders, body: serialized, redirect: "error",
    signal: signal ?? AbortSignal.timeout(30_000) };
  const unpaid = await fetchImpl(resource.href, init);
  if (unpaid.status !== 402) {
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of unpaid.body ?? []) {
      size += chunk.byteLength;
      if (size > maximumResponseBytes) throw new RangeError("unpaid representation exceeds maximumResponseBytes");
      digest.update(chunk);
    }
    throw new X402ResourceResponseError(`resource did not return an x402 payment requirement: HTTP ${unpaid.status}`, {
      boundary: "unpaid resource response", status: unpaid.status,
      contentType: unpaid.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null,
      bodySha256: digest.digest("hex"),
    });
  }
  // V2 carries the challenge in headers. It need not have a JSON body.
  let required;
  try { required = protocol.getPaymentRequiredResponse(name => unpaid.headers.get(name)); }
  finally { await unpaid.body?.cancel(); }
  if (required?.x402Version !== 2) throw new TypeError("one official x402 v2 challenge is required");
  const eligible = (required.accepts ?? []).filter(candidate =>
    candidate.scheme === "exact" && candidate.network === selectedNetwork
    && candidate.asset?.toLowerCase() === selectedAsset
    && ADDRESS.test(candidate.payTo?.toLowerCase() ?? "")
    && POSITIVE_INTEGER.test(candidate.amount ?? "")
    && BigInt(candidate.amount) <= BigInt(ceiling));
  if (eligible.length !== 1) throw new Error("resource did not offer exactly one admitted exact-EVM payment requirement");
  const requirement = structuredClone(eligible[0]);
  const payload = await protocol.createPaymentPayload({ ...required, accepts: [requirement] });
  const request = Object.freeze({
    url: resource.href, method,
    bodySha256: createHash("sha256").update(serialized ?? "").digest("hex"),
  });
  await beforePayment?.({
    request: { ...request, headers: { ...requestHeaders }, ...(serialized === undefined ? {} : { body: serialized }) },
    requirement: structuredClone(requirement), paymentPayload: structuredClone(payload),
  });
  const paid = await fetchImpl(resource.href, {
    ...init, headers: { ...requestHeaders, ...protocol.encodePaymentSignatureHeader(payload) },
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const payment = await protocol.processPaymentResult(payload, name => paid.headers.get(name), paid.status);
  const settlement = payment.settleResponse;
  const settlementMatchesRequirements = settlement?.success === true
    && settlement.network === selectedNetwork
    && HASH.test(settlement.transaction?.toLowerCase() ?? "")
    && (settlement.payer === undefined || settlement.payer.toLowerCase() === account)
    && (settlement.amount === undefined || settlement.amount === requirement.amount);
  const receipt = {
    type: "X402HttpPurchaseReceipt", customer: payer.caip10, request, requirement,
    ...(settlement === undefined ? {} : { settlement }),
    settlementMatchesRequirements,
    status: paid.status,
  };
  if (settlement !== undefined) await onSettlement?.(structuredClone(receipt));
  if (!settlementMatchesRequirements) {
    await paid.body?.cancel();
    const error = new Error("paid response does not carry a matching successful x402 settlement");
    error.receipt = receipt;
    throw error;
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of paid.body ?? []) {
      size += chunk.byteLength;
      if (size > maximumResponseBytes) throw new RangeError("purchased representation exceeds maximumResponseBytes");
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    error.receipt = receipt;
    throw error;
  }
  const bytes = Buffer.concat(chunks);
  return Object.freeze({
    ...receipt,
    delivery: Object.freeze({
      status: paid.status, ok: paid.ok, contentType: paid.headers.get("content-type"),
      bytes: size, sha256: createHash("sha256").update(bytes).digest("hex"),
      encoding: "base64", body: bytes.toString("base64"),
    }),
  });
}

export async function purchaseExactResource(options = {}) {
  requiredSturdyRef(options.sturdyRef);
  if (!ADDRESS.test(options.payer?.exchange ?? "")) {
    throw new Error("payer is not bound to the canonical SemioticExchange deployment");
  }
  const receipt = await purchaseHttpResource({
    ...options, method: "POST",
    headers: { ...options.headers, authorization: `OCapN ${options.sturdyRef}` },
  });
  const representation = receipt.delivery;
  const contentType = representation.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  let responseBody;
  try {
    if (contentType !== "application/json" && !contentType?.endsWith("+json")) throw new TypeError("not JSON");
    responseBody = JSON.parse(Buffer.from(representation.body, "base64").toString("utf8"));
  } catch (cause) {
    const error = new X402ResourceResponseError("paid resource response returned an invalid JSON representation", {
      boundary: "paid resource response", status: receipt.status, contentType,
      bodySha256: representation.sha256, cause,
    });
    error.receipt = receipt;
    throw error;
  }
  const result = typeof responseBody.result === "string" ? new URL(responseBody.result, options.url) : null;
  if (receipt.status !== 202 || typeof responseBody.invocation !== "string" || !result
      || result.origin !== new URL(options.url).origin || result.username || result.password || result.hash) {
    const error = new Error("SemioticExchange purchase requires a same-origin asynchronous result");
    error.receipt = receipt;
    throw error;
  }
  return Object.freeze({
    type: "X402ExactPurchaseReceipt", customer: receipt.customer,
    exchange: Object.freeze({
      network: options.network, address: options.payer.exchange,
      deploymentBlock: options.payer.deploymentBlock,
    }),
    resource: receipt.request.url, request: receipt.request, requirement: receipt.requirement,
    invocation: responseBody.invocation, result: result.href, settlement: receipt.settlement,
  });
}

export async function awaitPurchasedResult({
  receipt,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = 250,
  signal,
  onObservation,
} = {}) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError("pollIntervalMs must be a positive safe integer");
  }
  for (;;) {
    signal?.throwIfAborted();
    const response = await fetchImpl(receipt.result, {
      headers: { accept: "application/json" }, redirect: "error",
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const body = await exactJsonResponse(response, "purchased result response");
    await onObservation?.(Object.freeze({ status: response.status, body }));
    if (!response.ok) throw new Error(`purchased result refused observation: HTTP ${response.status}`);
    if (body.status === "terminal") {
      if (body.terminal?.type?.endsWith("Refusal")) {
        throw new Error(`paid capability refused delivery: ${body.terminal.reason ?? "unknown refusal"}`);
      }
      assertTerminalSettlementEvidence(receipt, body.terminal);
      return Object.freeze({ ...receipt, delivery: body.terminal });
    }
    await delay(pollIntervalMs, undefined, { signal });
  }
}

export async function purchaseAndAwaitExactResource(options) {
  return awaitPurchasedResult({
    receipt: await purchaseExactResource(options),
    fetchImpl: options.fetchImpl,
    pollIntervalMs: options.pollIntervalMs,
    signal: options.signal,
    onObservation: options.onObservation,
  });
}
