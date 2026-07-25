import { readFile } from "node:fs/promises";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { openSettlementSigner } from "@emsenn/enterprise-account-provisioning-service/custody";
import { X402_EXACT_PURCHASE_LAW } from "./law.mjs";

const CAIP2 = /^eip155:[1-9][0-9]*$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;

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

export async function openEnterpriseAccountPayer({
  accountBindingPath,
  keystorePath,
  passwordFile,
} = {}) {
  const binding = JSON.parse(await readFile(accountBindingPath, "utf8"));
  exactNetwork(binding?.chain?.caip2);
  const account = binding?.account?.address?.toLowerCase();
  const policySigner = binding?.policy?.signer?.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(account ?? "") || !/^0x[0-9a-f]{40}$/u.test(policySigner ?? "")) {
    throw new Error("payer binding must name one enterprise account and policy signer");
  }
  const controller = await openSettlementSigner({ path: keystorePath, passwordFile });
  if (controller.address.toLowerCase() !== policySigner) {
    throw new Error("encrypted custody does not control the enterprise account policy signer");
  }
  return Object.freeze({
    network: binding.chain.caip2,
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
  const unpaidBody = await unpaid.json();
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
  const responseBody = await paid.json();
  const payment = await protocol.processPaymentResult(
    payload,
    (name) => paid.headers.get(name),
    paid.status,
  );
  if (paid.status !== 202 || payment.settleResponse?.success !== true) {
    throw new Error(`x402 settlement failed: HTTP ${paid.status}`);
  }
  return Object.freeze({
    type: "X402ExactPurchaseReceipt",
    law: X402_EXACT_PURCHASE_LAW.id,
    customer: payer.caip10,
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
    const body = await response.json();
    await onObservation?.(Object.freeze({ status: response.status, body }));
    if (!response.ok) throw new Error(`purchased result refused observation: HTTP ${response.status}`);
    if (body.status === "terminal") {
      if (body.terminal?.type?.endsWith("Refusal")) {
        throw new Error(`paid capability refused delivery: ${body.terminal.reason ?? "unknown refusal"}`);
      }
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
