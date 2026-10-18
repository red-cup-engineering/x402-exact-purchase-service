import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import {
  challengeNamesResource, matchesExactPaymentSettlementReport, readHttpPurchaseQuote, readHttpPurchaseTerms, selectExactPaymentRequirement,
} from "../src/http-quote.mjs";

const url = "https://merchant.example/report?for=buyer";
const network = "eip155:8453";
const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const payTo = "0x2222222222222222222222222222222222222222";
const terms = Object.freeze({
  scheme: "exact", network, asset, payTo, amount: "7",
  maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
});
const owner = Object.freeze({ network, asset, maximumAmount: "7", expectedPayTo: payTo });

function challenge({ offered = [terms], quotedUrl = url, version = 2 } = {}) {
  return new Response("", {
    status: 402,
    headers: { "payment-required": encodePaymentRequiredHeader({
      x402Version: version, resource: { url: quotedUrl, mimeType: "application/json" },
      accepts: offered,
    }) },
  });
}

test("inspect official v2 POST quote without signer, settlement or paid replay", async () => {
  let count = 0;
  const body = { intent: "analyze" }, serialized = JSON.stringify(body);
  const result = await readHttpPurchaseQuote({
    url, method: "POST", body, ...owner,
    fetchImpl: async (target, init) => {
      assert.equal(++count, 1);
      assert.equal(target, url);
      assert.equal(init.method, "POST");
      assert.equal(init.body, serialized);
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["content-type"], "application/json");
      assert.equal(new Headers(init.headers).has("payment-signature"), false);
      return challenge();
    },
  });
  assert.equal(count, 1, "a quote never transmits a second (paid) request");
  assert.equal(result.type, "X402HttpQuote");
  assert.equal(result.request.bodySha256, createHash("sha256").update(serialized).digest("hex"));
  assert.deepEqual(result.requirement, terms);
  assert.equal(result.maximumAmount, "7");
  assert.equal(result.expectedPayTo, payTo);
  assert.deepEqual(result.authority, {
    paymentAttempted: false, signingAttempted: false,
    settlementObserved: false, deliveryObserved: false,
  });
  assert.equal("paymentPayload" in result, false);
});

test("the same pure selection respects buyer network, asset, payee and atomic ceiling", () => {
  const v2 = { x402Version: 2, resource: { url }, accepts: [terms] };
  assert.deepEqual(selectExactPaymentRequirement(v2, owner), terms);
  for (const amended of [
    { amount: "8" },
    { asset: "0x3333333333333333333333333333333333333333" },
    { payTo: "0x3333333333333333333333333333333333333333" },
    { network: "eip155:1" },
  ]) {
    assert.throws(() => selectExactPaymentRequirement({
      x402Version: 2, resource: { url }, accepts: [{ ...terms, ...amended }],
    }, owner), /exactly one admitted/u);
  }
  assert.throws(() => selectExactPaymentRequirement({
    x402Version: 2, resource: { url }, accepts: [terms, terms],
  }, owner), /exactly one admitted/u);
  assert.throws(() => selectExactPaymentRequirement({ x402Version: 1, resource: { url }, accepts: [terms] }, owner), /v2/u);
  assert.throws(() => selectExactPaymentRequirement(v2, {
    ...owner, maximumAmount: "0",
  }), /positive integer/u);
  assert.throws(() => selectExactPaymentRequirement({
    ...v2, accepts: [{ ...terms, maxTimeoutSeconds: -1 }],
  }, owner), "invalid protocol timeout cannot be priced for purchase");
  assert.throws(() => selectExactPaymentRequirement({
    ...v2, accepts: [{ ...terms, maxTimeoutSeconds: undefined }],
  }, owner), "missing protocol timeout cannot be priced for purchase");
});

test("inspect query-free canonical quote but refuse rewritten query, host or path", async () => {
  assert.equal(challengeNamesResource({ resource: { url: "https://merchant.example/report" } }, url), true);
  assert.equal(challengeNamesResource({ resource: { url: url.replace("buyer", "attacker") } }, url), false);
  for (const quotedUrl of [
    "https://another.example/report?for=buyer",
    "https://merchant.example/report?for=attacker",
    "https://merchant.example/another",
  ]) {
    await assert.rejects(readHttpPurchaseQuote({
      url, ...owner, fetchImpl: async () => challenge({ quotedUrl }),
    }), /different resource URL/u);
  }
  const observed = await readHttpPurchaseQuote({
    url, ...owner, fetchImpl: async () => challenge({
      quotedUrl: "https://merchant.example/report",
    }),
  });
  assert.equal(observed.request.url, url);
});

test("refuse malformed or unsigned challenge, and non-402 is not interpreted as a free purchase", async () => {
  await assert.rejects(readHttpPurchaseQuote({
    url, ...owner, fetchImpl: async () => new Response("free", { status: 200 }),
  }), error => error.code === "X402_QUOTE_NOT_REQUIRED" && error.status === 200);
  await assert.rejects(readHttpPurchaseQuote({
    url, ...owner, fetchImpl: async () => new Response("", { status: 402 }),
  }), /payment-required header/u);
  await assert.rejects(readHttpPurchaseQuote({
    url, ...owner, fetchImpl: async () => challenge({
      offered: [{ ...terms, amount: "8" }],
    }),
  }), /exactly one admitted/u);
});

test("owner admission precedes egress and payment signatures are never imported", async () => {
  let networkCalls = 0;
  const fetchImpl = () => { networkCalls++; throw new Error("must not call network"); };
  await assert.rejects(readHttpPurchaseQuote({ url, ...owner,
    maximumAmount: "-1", fetchImpl,
  }), /positive integer/u);
  await assert.rejects(readHttpPurchaseQuote({ url, ...owner,
    expectedPayTo: "other", fetchImpl,
  }), /expectedPayTo/u);
  await assert.rejects(readHttpPurchaseQuote({ url, ...owner,
    headers: { "PAYMENT-SIGNATURE": "replay" }, fetchImpl,
  }), /ambient payment signature/u);
  await assert.rejects(readHttpPurchaseQuote({ url: "http://merchant.example", ...owner,
    fetchImpl,
  }), /HTTPS/u);
  await assert.rejects(readHttpPurchaseQuote({ url, ...owner }), /fetchImpl/u);
  assert.equal(networkCalls, 0);
});

test("one source-owned settlement report matcher retains positive, adverse and optional-field cases", () => {
  const valid = { success: true, network, transaction: "0x" + "a".repeat(64) };
  const ownerTerms = { network, asset, amount: "7", payTo, payer: "0x" + "4".repeat(40) };
  assert.equal(matchesExactPaymentSettlementReport(valid, ownerTerms), true,
    "the protocol permits omitted optional facilitator details");
  assert.equal(matchesExactPaymentSettlementReport({
    ...valid, payee: payTo.toUpperCase().replace("0X", "0x"), amount: "7",
    asset: asset.toUpperCase().replace("0X", "0x"), payer: ownerTerms.payer,
  }, ownerTerms), true);
  for (const changed of [
    { success: false },
    { network: "eip155:1" },
    { transaction: "not-a-hash" },
    { payee: "0x" + "5".repeat(40) },
    { payTo: "0x" + "5".repeat(40) },
    { asset: "0x" + "5".repeat(40) },
    { payer: "0x" + "5".repeat(40) },
    { amount: "8" },
    { payer: 1234 },
    { payTo: null },
  ]) {
    assert.equal(matchesExactPaymentSettlementReport({ ...valid, ...changed }, ownerTerms),
      false, "contradictory/invalid reported terms cannot be accepted");
  }
  assert.equal(matchesExactPaymentSettlementReport(valid, { ...ownerTerms, payTo: "" }), false,
    "missing owner recipient is not an acceptable receipt authority");
});

test("durable purchase receives the original validated server challenge and the SAME exact owner-selected quote", async () => {
  let probes = 0;
  const inputs = {url, ...owner, fetchImpl: async (_url, init) => {
    probes++;
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).has("payment-signature"), false);
    return challenge();
  }};
  const receipt = await readHttpPurchaseTerms(inputs);
  assert.equal(probes, 1);
  assert.equal(receipt.quote.type, "X402HttpQuote");
  assert.deepEqual(receipt.quote.requirement, terms);
  assert.equal(receipt.paymentRequired.x402Version, 2);
  assert.equal(receipt.paymentRequired.resource.url, url);
  assert.deepEqual(receipt.paymentRequired.accepts, [terms]);
  assert.equal(receipt.quote.authority.paymentAttempted, false);
  assert.equal(receipt.quote.authority.signingAttempted, false);
  assert.equal(receipt.paymentSignature, undefined);
  // The independent signed-request owner can select exactly the admitted
  // payment requirement while retaining resource extensions for the SDK.
  const selected = {...receipt.paymentRequired, accepts: [receipt.quote.requirement]};
  assert.deepEqual(selectExactPaymentRequirement(selected, owner), terms);
  assert.notStrictEqual(receipt.paymentRequired.accepts[0], receipt.quote.requirement);
});

test("durable quote refuses substitute recipient, origin, method and over-ceiling value before signing", async () => {
  const cases = [
    {fetchImpl: async () => challenge({offered:[{...terms,payTo:"0x"+"6".repeat(40)}]})},
    {fetchImpl: async () => challenge({offered:[{...terms,amount:"8"}]})},
    {fetchImpl: async () => challenge({quotedUrl:"https://other.example/report?for=buyer"})},
  ];
  for (const opts of cases) {
    await assert.rejects(readHttpPurchaseTerms({url,...owner,...opts}),
      /exactly one admitted|different resource URL/u);
  }
  let calls = 0;
  await assert.rejects(readHttpPurchaseTerms({url,...owner,expectedPayTo:"bad",
    fetchImpl: async()=>{calls++;return challenge();}}),/expectedPayTo/u);
  assert.equal(calls,0);
});
