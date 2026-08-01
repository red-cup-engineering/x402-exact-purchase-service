import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
  for await (const chunk of response.body) digest.update(chunk);
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
  const text = await response.text();
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

export async function purchaseExactResource({
  url,
  body,
  sturdyRef,
  payer,
  network,
  rpcUrl,
  maximumAmount,
  fetchImpl = globalThis.fetch,
  httpClient,
} = {}) {
  if (!/^https:\/\//u.test(url ?? "")) throw new TypeError("resource URL must use HTTPS");
  const selectedNetwork = exactNetwork(network);
  const ceiling = exactAmount(maximumAmount, "maximumAmount");
  requiredSturdyRef(sturdyRef);
  if (payer?.network !== selectedNetwork || payer?.signer?.address == null) {
    throw new Error("payer is not bound to the selected settlement network");
  }
  if (!ADDRESS.test(payer?.exchange ?? "")) {
    throw new Error("payer is not bound to the canonical SemioticExchange deployment");
  }
  const protocol = httpClient ?? (() => {
    const client = new x402Client();
    registerExactEvmScheme(client, {
      signer: payer.signer,
      networks: [selectedNetwork],
      schemeOptions: { rpcUrl },
    });
    return new x402HTTPClient(client);
  })();
  const baseHeaders = {
    authorization: `OCapN ${sturdyRef}`,
    "content-type": "application/json",
  };
  const serialized = JSON.stringify(body);
  const unpaid = await fetchImpl(url, { method: "POST", headers: baseHeaders, body: serialized });
  const unpaidBody = await exactJsonResponse(unpaid, "unpaid resource response");
  if (unpaid.status !== 402) {
    throw new Error(`resource did not return an x402 payment requirement: HTTP ${unpaid.status}`);
  }
  const requirement = protocol.getPaymentRequiredResponse(
    (name) => unpaid.headers.get(name),
    unpaidBody,
  );
  const eligible = (requirement.accepts ?? []).filter((candidate) =>
    candidate.scheme === "exact"
      && candidate.network === selectedNetwork
      && POSITIVE_INTEGER.test(candidate.amount ?? "")
      && BigInt(candidate.amount) <= BigInt(ceiling));
  if (eligible.length !== 1) {
    throw new Error("resource did not offer exactly one admitted exact-EVM payment requirement");
  }
  const selected = { ...requirement, accepts: eligible };
  const payload = await protocol.createPaymentPayload(selected);
  const paid = await fetchImpl(url, {
    method: "POST",
    headers: { ...baseHeaders, ...protocol.encodePaymentSignatureHeader(payload) },
    body: serialized,
  });
  const responseBody = await exactJsonResponse(paid, "paid resource response");
  const payment = await protocol.processPaymentResult(
    payload,
    (name) => paid.headers.get(name),
    paid.status,
  );
  if (paid.status !== 202 || payment.settleResponse?.success !== true) {
    const paymentRequired = paid.status === 402
      ? protocol.getPaymentRequiredResponse(
        (name) => paid.headers.get(name),
        responseBody,
      )
      : null;
    const reason = payment.settleResponse?.errorReason
      ?? paymentRequired?.error
      ?? responseBody?.error
      ?? responseBody?.message
      ?? "settlement response supplied no reason";
    throw new Error(`x402 settlement failed: HTTP ${paid.status}: ${reason}`);
  }
  return Object.freeze({
    type: "X402ExactPurchaseReceipt",
    customer: payer.caip10,
    exchange: Object.freeze({
      network: selectedNetwork,
      address: payer.exchange,
      deploymentBlock: payer.deploymentBlock,
    }),
    resource: url,
    requirement: eligible[0],
    invocation: responseBody.invocation,
    result: new URL(responseBody.result, url).href,
    settlement: payment.settleResponse,
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
    const response = await fetchImpl(receipt.result, { headers: { accept: "application/json" }, signal });
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
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("purchase observation aborted"));
      }, { once: true });
    });
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
