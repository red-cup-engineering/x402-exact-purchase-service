import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { authorizeQuotedHttpPayment } from "../src/http-authorization.mjs";
import { readHttpPurchaseTerms } from "../src/http-quote.mjs";

// Public development signer, fake 402; no chain, settlement, money or network.
const network = "eip155:8453";
const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const payTo = "0x2222222222222222222222222222222222222222";
const url = "https://merchant.example/edition";
const signer = privateKeyToAccount("0x" + "1".padStart(64, "0"));
const payer = { signer, network, caip10: network + ":" + signer.address };
const owner = { network, asset, maximumAmount: "7", expectedPayTo: payTo };
const requirements = {
  scheme: "exact", network, asset, amount: "7", payTo,
  maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
};

async function terms(overrides = {}) {
  return readHttpPurchaseTerms({
    url, ...owner, ...overrides,
    fetchImpl: async () => new Response("", { status: 402, headers: {
      "payment-required": encodePaymentRequiredHeader({
        x402Version: 2, resource: { url, mimeType: "application/octet-stream" },
        accepts: [requirements],
      }),
    } }),
  });
}

test("one Engineering signer prepares a durable exact-EVM authorization without egress or payment", async () => {
  const observed = await terms();
  const signed = await authorizeQuotedHttpPayment({
    url, terms: observed, payer, ...owner,
  });
  assert.equal(signed.type, "X402PreparedExactHttpAuthorization");
  assert.equal(signed.payer.toLowerCase(), payer.caip10.toLowerCase());
  assert.equal(signed.request.url, url);
  assert.deepEqual(signed.requirement, requirements);
  assert.deepEqual(signed.authority, {
    signingAttempted: true, paymentAttempted: false,
    settlementObserved: false, deliveryObserved: false,
  });
  const payload = decodePaymentSignatureHeader(signed.paymentSignature);
  assert.equal(payload.x402Version, 2);
  assert.deepEqual(payload.accepted, requirements);
  assert.equal(payload.payload.authorization.from.toLowerCase(), signer.address.toLowerCase());
  assert.equal(payload.payload.authorization.to.toLowerCase(), payTo.toLowerCase());
  assert.equal(payload.payload.authorization.value, "7");
  assert.match(payload.payload.signature, /^0x[0-9a-f]+$/iu);
});

test("a different valid POST quotation signs only its original body and headers", async () => {
  const method = "POST";
  const body = { operation: "analyse", input: { count: 3 } };
  const headers = { accept: "application/json", "x-purpose": "science" };
  const observed = await terms({ method, body, headers });
  const prepared = await authorizeQuotedHttpPayment({
    url, method, body, headers, terms: observed, payer, ...owner,
  });
  assert.deepEqual(prepared.request, observed.quote.request);
  const decoded = decodePaymentSignatureHeader(prepared.paymentSignature);
  assert.deepEqual(decoded.accepted, requirements);
  assert.equal(decoded.payload.authorization.to.toLowerCase(), payTo);
  assert.equal(prepared.authority.paymentAttempted, false);
});

test("owner admission and quote lock refuse substitution before reaching signing client", async () => {
  const observed = await terms();
  let calls = 0;
  const client = {
    async createPaymentPayload() { calls++; throw new Error("must never sign"); },
  };
  const base = { url, terms: observed, payer, client, ...owner };
  for (const change of [
    { url: "https://merchant.example/another-edition" },
    { method: "POST", body: { unsolicited: true } },
    { headers: { accept: "application/json" } },
    { maximumAmount: "70" },
    { expectedPayTo: "0x" + "3".repeat(40) },
    { asset: "0x" + "3".repeat(40) },
    { network: "eip155:1" },
    { payer: { ...payer, caip10: "eip155:8453:forged" } },
  ]) {
    await assert.rejects(
      authorizeQuotedHttpPayment({ ...base, ...change }),
      /different resource|owner-admitted|payer must bind|exactly one admitted/u,
      JSON.stringify(change),
    );
  }
  await assert.rejects(authorizeQuotedHttpPayment({
    ...base, expectedPayTo: undefined,
  }), /independently authorized expectedPayTo/u);
  const conflicting = structuredClone(observed);
  conflicting.paymentRequired.accepts[0].maxTimeoutSeconds = 120;
  await assert.rejects(authorizeQuotedHttpPayment({
    ...base, terms: conflicting,
  }), error => error.code === "X402_QUOTE_DRIFT");
  assert.equal(calls, 0, "no signer capability entered before full owner admission");
});

test("malformed signer output cannot become a durable authorized credential", async () => {
  const observed = await terms();
  await assert.rejects(authorizeQuotedHttpPayment({
    url, terms: observed, payer, ...owner,
    client: { createPaymentPayload: async () => ({
      x402Version: 2, accepted: { ...requirements, amount: "8" }, payload: {},
    }) },
  }), /different payment authorization/u);
});
