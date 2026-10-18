import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData } from "viem";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { purchaseHttpResource } from "../src/purchase.mjs";
import { readHttpPurchaseQuote } from "../src/http-quote.mjs";

// Public development key; no live network, facilitator or funds are used.
const signer = privateKeyToAccount("0x" + "1".padStart(64, "0"));
const network = "eip155:8453";
const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const payTo = "0x2222222222222222222222222222222222222222";
const transaction = "0x" + "a".repeat(64);
const payer = { signer, network, caip10: `${network}:${signer.address}` };
const terms = { scheme: "exact", network, asset, payTo, amount: "7",
  maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
const url = "https://ordinary.example/report?q=one";
function challenge(accepts = [terms]) {
  return new Response("Payment required, not a JSON body", { status: 402,
    headers: { "payment-required": encodePaymentRequiredHeader({
      x402Version: 2, resource: { url, mimeType: "application/octet-stream" }, accepts,
    }) } });
}
function delivered(body = new Uint8Array([0, 255, 42]), settlement = {}) {
  return new Response(body, { headers: {
    "content-type": "application/octet-stream",
    "payment-response": encodePaymentResponseHeader({
      success: true, network, transaction, payer: signer.address, ...settlement,
    }),
  } });
}
const options = { url, payer, network, asset, maximumAmount: "7" };

test("a payable resource cannot use ambient network authority", async () => {
  await assert.rejects(purchaseHttpResource({ ...options }),
    /owner-controlled egress-safe fetchImpl/u);
  await assert.rejects(purchaseHttpResource({ ...options, fetchImpl: null }),
    /owner-controlled egress-safe fetchImpl/u);
});

test("a buyer-admitted unsigned quote can lock the exact later payable request", async () => {
  const acceptedQuote = await readHttpPurchaseQuote({
    url, network, asset, maximumAmount: "7", expectedPayTo: payTo,
    headers: { accept: "application/octet-stream", "x-customer": "one" },
    fetchImpl: async () => challenge(),
  });
  let calls = 0, before = 0;
  const received = await purchaseHttpResource({
    ...options, expectedPayTo: payTo, acceptedQuote,
    headers: { "x-customer": "one", ACCEPT: "application/octet-stream" },
    beforePayment: () => { before++; },
    fetchImpl: async () => ++calls === 1 ? challenge() : delivered(),
  });
  assert.equal(calls, 2);
  assert.equal(before, 1);
  assert.equal(received.settlementMatchesRequirements, true);
  assert.deepEqual(received.requirement, acceptedQuote.requirement);
  assert.deepEqual(received.request, acceptedQuote.request);
});

test("quote lock refuses request or challenge drift before any payment signature", async () => {
  const acceptedQuote = await readHttpPurchaseQuote({
    url, network, asset, maximumAmount: "7",
    fetchImpl: async () => challenge(),
  });
  let egress = 0;
  await assert.rejects(purchaseHttpResource({
    ...options, acceptedQuote, method: "POST", body: { intent: "changed" },
    fetchImpl: async () => { egress++; throw new Error("must not enter network"); },
  }), error => error.code === "X402_QUOTE_DRIFT");
  assert.equal(egress, 0, "request drift is rejected before the first probe");

  const headerQuote = await readHttpPurchaseQuote({
    url, network, asset, maximumAmount: "7",
    headers: { accept: "application/json" },
    fetchImpl: async () => challenge(),
  });
  await assert.rejects(purchaseHttpResource({
    ...options, acceptedQuote: headerQuote,
    headers: { accept: "application/octet-stream" },
    fetchImpl: async () => { egress++; throw new Error("must not enter network"); },
  }), error => error.code === "X402_QUOTE_DRIFT");
  assert.equal(egress, 0, "changed representation headers cannot enter the network");

  for (const altered of [
    { ...terms, amount: "6" },
    { ...terms, maxTimeoutSeconds: 90 },
    { ...terms, payTo: "0x3333333333333333333333333333333333333333" },
    { ...terms, extra: { name: "Unexpected token", version: "2" } },
  ]) {
    let calls = 0, intents = 0;
    await assert.rejects(purchaseHttpResource({
      ...options, acceptedQuote,
      beforePayment: () => { intents++; },
      fetchImpl: async () => { calls++; return challenge([altered]); },
    }), error => error.code === "X402_QUOTE_DRIFT");
    assert.equal(calls, 1, "only the unsigned 402 probe can occur");
    assert.equal(intents, 0, "the wallet cannot sign changed quoted terms");
  }
});

test("ordinary GET: the official SDK signs, the owner records before sending, and exact bytes return", async () => {
  const order = [], calls = [];
  const receipt = await purchaseHttpResource({
    ...options,
    beforePayment: intent => {
      order.push("intent");
      assert.equal(intent.request.url, url);
      assert.equal(intent.requirement.asset, asset);
      assert.equal(intent.paymentPayload.accepted.amount, "7");
    },
    onSettlement: receipt => { order.push("settlement"); assert.equal(receipt.settlement.transaction, transaction); },
    fetchImpl: async (resource, init) => {
      assert.equal(resource, url);
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "GET");
      calls.push(init);
      if (calls.length === 1) return challenge();
      order.push("paid");
      const payment = decodePaymentSignatureHeader(new Headers(init.headers).get("payment-signature"));
      assert.deepEqual(payment.accepted, terms);
      const authorization = payment.payload.authorization;
      assert.equal(authorization.from.toLowerCase(), signer.address.toLowerCase());
      assert.equal(authorization.to, payTo);
      assert.equal(authorization.value, "7");
      assert.equal(await verifyTypedData({
        address: signer.address, signature: payment.payload.signature,
        domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: asset },
        types: { TransferWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" },
          { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ] },
        primaryType: "TransferWithAuthorization", message: authorization,
      }), true);
      return delivered();
    },
  });
  assert.deepEqual(order, ["intent", "paid", "settlement"]);
  assert.equal(calls.length, 2);
  assert.equal(receipt.customer, payer.caip10);
  assert.equal(receipt.delivery.body, "AP8q");
  assert.equal(receipt.delivery.sha256, createHash("sha256").update(Buffer.from([0,255,42])).digest("hex"));
  assert.equal(receipt.exchange, undefined);
});

test("POST preserves exact method, body and caller headers", async () => {
  const calls = [];
  const receipt = await purchaseHttpResource({
    ...options, method: "POST", body: { need: "résumé" }, headers: { "x-customer": "enterprise-one" },
    fetchImpl: async (_resource, init) => {
      calls.push(init);
      return calls.length === 1 ? challenge() : delivered('{"done":true}');
    },
  });
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].body, calls[0].body);
  assert.equal(calls[1].headers["x-customer"], "enterprise-one");
  assert.equal(calls[1].headers["content-type"], "application/json");
  assert.equal(receipt.request.bodySha256, createHash("sha256").update(calls[1].body).digest("hex"));
});

test("challenge cannot rewrite the requested origin, path, or nonempty query", async () => {
  for (const alteredUrl of [
    "https://unrelated.example/report?q=one",
    "https://ordinary.example/report?q=two",
    "https://ordinary.example/other",
  ]) {
    let calls = 0, intents = 0;
    const challenged = new Response("", {
      status: 402,
      headers: { "payment-required": encodePaymentRequiredHeader({
        x402Version: 2, resource: { url: alteredUrl }, accepts: [terms],
      }) },
    });
    await assert.rejects(purchaseHttpResource({
      ...options,
      beforePayment: () => { intents++; },
      fetchImpl: async () => { calls++; return challenged; },
    }), error => {
      assert.equal(error.code, "X402_RESOURCE_INVALID_RESPONSE");
      assert.equal(error.boundary, "unpaid resource challenge");
      assert.equal(error.status, 402);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal(intents, 0);
  }
});

test("a canonical query-free endpoint challenge is payable while preserving the input query", async () => {
  const canonical = "https://ordinary.example/report";
  let calls = 0, savedRequest, chargedReceipt;
  const result = await purchaseHttpResource({
    ...options,
    beforePayment: ({ request }) => { savedRequest = request; },
    onSettlement: receipt => { chargedReceipt = receipt; },
    fetchImpl: async (requestedUrl, init) => {
      assert.equal(requestedUrl, url);
      if (++calls === 1) return new Response("", {
        status: 402, headers: { "payment-required": encodePaymentRequiredHeader({
          x402Version: 2, resource: { url: canonical }, accepts: [terms],
        }) },
      });
      assert.equal(init.method, "GET");
      assert.ok(new Headers(init.headers).has("payment-signature"));
      return delivered();
    },
  });
  assert.equal(calls, 2);
  assert.equal(savedRequest.url, url);
  assert.equal(chargedReceipt.settlement.transaction, transaction);
  assert.equal(result.delivery.sha256, createHash("sha256").update(Buffer.from([0,255,42])).digest("hex"));
});

test("wrong token and excessive price cannot reach the signed request", async () => {
  for (const amendment of [{ asset: payTo }, { amount: "8" }]) {
    let calls = 0, intents = 0;
    await assert.rejects(purchaseHttpResource({
      ...options, beforePayment: () => intents++,
      fetchImpl: async () => { calls++; return challenge([{ ...terms, ...amendment }]); },
    }), /exactly one admitted/);
    assert.equal(calls, 1);
    assert.equal(intents, 0);
  }
});


test("an independently admitted payee cannot be redirected by the unsigned challenge", async () => {
  let calls = 0, intents = 0;
  await assert.rejects(purchaseHttpResource({
    ...options, expectedPayTo: "0x3333333333333333333333333333333333333333",
    beforePayment: () => { intents++; },
    fetchImpl: async () => { calls++; return challenge(); },
  }), /exactly one admitted/u);
  assert.equal(calls, 1, "the signed payment must never be sent");
  assert.equal(intents, 0, "there is no payment intent for a refused recipient");

  let acceptedCalls = 0;
  const receipt = await purchaseHttpResource({
    ...options, expectedPayTo: payTo.toUpperCase().replace("0X", "0x"),
    fetchImpl: async () => ++acceptedCalls === 1 ? challenge() : delivered(),
  });
  assert.equal(acceptedCalls, 2);
  assert.equal(receipt.requirement.payTo, payTo);
  await assert.rejects(purchaseHttpResource({
    ...options, expectedPayTo: "not-an-address", fetchImpl: async () => { throw new Error("network must not be entered"); },
  }), /expectedPayTo must be/u);
});

test("contradictory reported payee or asset is retained but never accepted as successful settlement", async () => {
  for (const contradicted of [
    { payee: "0x3333333333333333333333333333333333333333" },
    { payTo: "0x3333333333333333333333333333333333333333" },
    { asset: "0x3333333333333333333333333333333333333333" },
  ]) {
    let calls = 0, witness;
    const client = {
      getPaymentRequiredResponse: () => ({ x402Version: 2, resource: { url }, accepts: [terms] }),
      createPaymentPayload: async () => ({ accepted: terms }),
      encodePaymentSignatureHeader: () => ({ "payment-signature": "signed-for-test" }),
      processPaymentResult: async () => ({ settleResponse: {
        success: true, network, transaction, payer: signer.address, ...contradicted,
      } }),
    };
    await assert.rejects(purchaseHttpResource({
      ...options, expectedPayTo: payTo, httpClient: client,
      onSettlement: value => { witness = value; },
      fetchImpl: async () => ++calls === 1 ? challenge() : delivered(),
    }), error => {
      assert.equal(error.code, "X402_SETTLEMENT_NOT_VERIFIED");
      assert.equal(error.receipt?.settlementMatchesRequirements, false);
      assert.equal(error.receipt?.delivery, undefined);
      return true;
    });
    assert.equal(calls, 2, "one signed payment attempt, never an automatic retry");
    assert.equal(witness.settlementMatchesRequirements, false);
    assert.deepEqual(Object.keys(contradicted).map(key => witness.settlement[key]),
      Object.values(contradicted), "retain the untrusted facilitator fields for reconciliation");
  }
});

test("settled delivery failure retains the charge evidence and does not invent a successful result", async () => {
  let calls = 0, observed;
  await assert.rejects(purchaseHttpResource({
    ...options, maximumResponseBytes: 2,
    onSettlement: receipt => { observed = receipt; },
    fetchImpl: async () => ++calls === 1 ? challenge() : delivered(),
  }), error => {
    assert.equal(error.receipt.settlement.transaction, transaction);
    assert.equal(error.receipt.delivery, undefined);
    return error instanceof RangeError;
  });
  assert.equal(observed.settlement.transaction, transaction);
  assert.equal(calls, 2);
});

test("settled HTTP 503 retains charge evidence but never delivers a failed computation", async () => {
  let calls = 0, observed;
  const failure = () => new Response("compute unavailable", { status: 503, headers: {
    "content-type": "text/plain",
    "payment-response": encodePaymentResponseHeader({
      success: true, network, transaction, payer: signer.address,
    }),
  } });
  await assert.rejects(purchaseHttpResource({
    ...options,
    onSettlement: receipt => { observed = receipt; },
    fetchImpl: async () => ++calls === 1 ? challenge() : failure(),
  }), error => {
    assert.equal(error.code, "X402_RESOURCE_INVALID_RESPONSE");
    assert.equal(error.boundary, "paid resource response");
    assert.equal(error.status, 503);
    assert.equal(error.receipt?.settlement?.transaction, transaction);
    assert.equal(error.receipt?.delivery, undefined);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(observed?.settlement?.transaction, transaction);
  assert.equal(observed?.status, 503);
});

test("a mismatched receipt is retained as reported evidence and refused as payment success", async () => {
  let calls = 0, observed;
  await assert.rejects(purchaseHttpResource({
    ...options, onSettlement: receipt => { observed = receipt; },
    fetchImpl: async () => ++calls === 1 ? challenge() : delivered("wrong", { network: "eip155:1" }),
  }), /matching successful/);
  assert.equal(observed.settlement.network, "eip155:1");
});

test("buyer preserves settlement evidence even when the owner's charge journal fails", async () => {
  let requests = 0, observed;
  await assert.rejects(purchaseHttpResource({
    ...options,
    onSettlement: receipt => {
      observed = receipt;
      throw new Error("owner journal unavailable");
    },
    fetchImpl: async () => ++requests === 1 ? challenge() : delivered(),
  }), error => {
    assert.equal(error.code, "X402_SETTLEMENT_OBSERVER_REFUSED");
    assert.match(error.message, /could not be journaled/u);
    assert.match(error.cause?.message ?? "", /journal unavailable/u);
    assert.equal(error.receipt?.settlement?.transaction, transaction);
    assert.equal(error.receipt?.request?.url, url);
    assert.equal(error.receipt?.delivery, undefined);
    return true;
  });
  assert.equal(requests, 2, "no automatic second payment");
  assert.equal(observed.settlement.transaction, transaction);
});

test("delivered bytes become a separately witnessed buyer event, without disclosing purchased content", async () => {
  const sequence = [];
  let delivery;
  let requests = 0;
  const output = await purchaseHttpResource({
    ...options,
    onSettlement: () => sequence.push("settlement"),
    onDelivery: value => { sequence.push("delivery"); delivery = value; },
    fetchImpl: async () => ++requests === 1 ? challenge() : delivered(),
  });
  assert.deepEqual(sequence, ["settlement", "delivery"]);
  assert.equal(requests, 2);
  assert.equal(delivery.type, "X402HttpPurchaseDeliveryObservation");
  assert.equal(delivery.delivery.sha256, output.delivery.sha256);
  assert.equal(delivery.delivery.bytes, output.delivery.bytes);
  assert.equal(delivery.delivery.status, 200);
  assert.equal(delivery.settlement.transaction, transaction);
  assert.equal(delivery.requesterAccepted, null);
  assert.equal("body" in delivery.delivery, false, "do not persist customer's purchased bytes through the recorder");
  assert.equal("paymentPayload" in delivery, false, "no signed authorization in seller/recipient receipt");
});

test("delivery journal failure preserves exact paid bytes and transaction; never retries", async () => {
  let requests = 0;
  await assert.rejects(purchaseHttpResource({
    ...options,
    onDelivery: () => { throw new Error("journal offline"); },
    fetchImpl: async () => ++requests === 1 ? challenge() : delivered(),
  }), error => {
    assert.equal(error.code, "X402_DELIVERY_OBSERVER_REFUSED");
    assert.match(error.cause?.message ?? "", /journal offline/u);
    assert.equal(error.receipt?.settlement?.transaction, transaction);
    assert.equal(error.receipt?.delivery?.sha256, createHash("sha256").update(Buffer.from([0,255,42])).digest("hex"));
    assert.equal(error.receipt?.delivery?.body, Buffer.from([0,255,42]).toString("base64"));
    return true;
  });
  assert.equal(requests, 2, "a failed ledger write must not trigger another charge");
});

test("an interrupted paid request leaves the owner's intent and never automatically repays", async () => {
  let calls = 0, intent;
  await assert.rejects(purchaseHttpResource({
    ...options, beforePayment: value => { intent = value; },
    fetchImpl: async () => {
      if (++calls === 1) return challenge();
      throw new Error("connection interrupted");
    },
  }), error => {
    assert.equal(error.code, "X402_PAYMENT_OUTCOME_UNKNOWN");
    assert.match(error.cause?.message ?? "", /connection interrupted/u);
    assert.equal(error.receipt?.type, "X402HttpPaymentAttempt");
    assert.equal(error.receipt?.settlementStatus, "unconfirmed");
    assert.equal(error.receipt?.request?.url, url);
    assert.equal(error.receipt?.settlement, undefined);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(intent.paymentPayload.accepted.amount, "7");
});

test("unreadable payment response retains unconfirmed signed attempt, not a failed or paid settlement", async () => {
  const attempts = [];
  let calls = 0;
  const client = {
    getPaymentRequiredResponse: () => ({ x402Version: 2, resource: { url }, accepts: [terms] }),
    createPaymentPayload: async () => ({ accepted: terms, payload: { signature: "private-signer-data" } }),
    encodePaymentSignatureHeader: () => ({ "payment-signature": "private-signer-data" }),
    processPaymentResult: async () => { throw new Error("settlement response transport lost"); },
  };
  await assert.rejects(purchaseHttpResource({
    ...options, httpClient: client,
    beforePayment: intent => attempts.push(intent),
    fetchImpl: async () => ++calls === 1 ? challenge() : delivered(),
  }), error => {
    assert.equal(error.code, "X402_PAYMENT_OUTCOME_UNKNOWN");
    assert.match(error.cause?.message ?? "", /transport lost/u);
    assert.equal(error.receipt?.type, "X402HttpPaymentAttempt");
    assert.equal(error.receipt?.settlementStatus, "unconfirmed");
    assert.equal(error.receipt?.requirement?.amount, "7");
    assert.equal(error.receipt?.status, 200);
    assert.equal(JSON.stringify(error.receipt).includes("private-signer-data"), false);
    assert.equal("settlement" in error.receipt, false);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(attempts.length, 1, "owner's pre-payment record remains available for recovery");
});

test("facilitator settlement_pending is not treated as either a delivered resource or a terminal failure", async () => {
  let calls = 0;
  const client = {
    getPaymentRequiredResponse: () => ({ x402Version: 2, resource: { url }, accepts: [terms] }),
    createPaymentPayload: async () => ({ accepted: terms }),
    encodePaymentSignatureHeader: () => ({ "payment-signature": "signed-dev" }),
    processPaymentResult: async () => ({ settleResponse: {
      success: false, network, transaction, errorReason: "settlement_pending",
    } }),
  };
  await assert.rejects(purchaseHttpResource({
    ...options, httpClient: client,
    fetchImpl: async () => ++calls === 1 ? challenge() : delivered(),
  }), error => {
    assert.equal(error.code, "X402_SETTLEMENT_PENDING");
    assert.equal(error.receipt?.settlement?.transaction, transaction);
    assert.equal(error.receipt?.settlementMatchesRequirements, false);
    assert.equal(error.receipt?.delivery, undefined);
    return true;
  });
  assert.equal(calls, 2, "no implicit second signed payment attempt");
});

