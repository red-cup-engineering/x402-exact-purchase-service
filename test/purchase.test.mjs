import assert from "node:assert/strict";
import test from "node:test";
import { awaitPurchasedResult, purchaseExactResource } from "../src/purchase.mjs";

const sturdyRef = `urn:ocapn:sturdyref:${"a".repeat(43)}`;
const payer = {
  network: "eip155:5",
  caip10: "eip155:5:0x1111111111111111111111111111111111111111",
  signer: { address: "0x1111111111111111111111111111111111111111" },
};

test("purchases exactly one admitted integer-priced requirement", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    return calls.length === 1
      ? Response.json({}, { status: 402, headers: { "payment-required": "test" } })
      : Response.json({ invocation: "sha256:paid", result: "/result/paid" }, { status: 202 });
  };
  const httpClient = {
    getPaymentRequiredResponse: () => ({
      accepts: [{ scheme: "exact", network: "eip155:5", amount: "7", payTo: "0x2222222222222222222222222222222222222222" }],
    }),
    createPaymentPayload: async () => ({ paid: true }),
    encodePaymentSignatureHeader: () => ({ "payment-signature": "signed" }),
    processPaymentResult: async () => ({ settleResponse: { success: true, transaction: "0xabc" } }),
  };
  const receipt = await purchaseExactResource({
    url: "https://provider.example/invoke",
    body: { demand: true },
    sturdyRef,
    payer,
    network: "eip155:5",
    rpcUrl: "https://rpc.example",
    maximumAmount: "7",
    fetchImpl,
    httpClient,
  });
  assert.equal(receipt.requirement.amount, "7");
  assert.equal(receipt.result, "https://provider.example/result/paid");
  assert.equal(calls[1].headers["payment-signature"], "signed");
});

test("refuses price drift above the admitted exact amount", async () => {
  const fetchImpl = async () => Response.json({}, { status: 402 });
  const httpClient = {
    getPaymentRequiredResponse: () => ({
      accepts: [{ scheme: "exact", network: "eip155:5", amount: "8" }],
    }),
  };
  await assert.rejects(purchaseExactResource({
    url: "https://provider.example/invoke",
    body: {},
    sturdyRef,
    payer,
    network: "eip155:5",
    rpcUrl: "https://rpc.example",
    maximumAmount: "7",
    fetchImpl,
    httpClient,
  }), /exactly one admitted/u);
});

test("waits without inventing a completion deadline and returns the delivered lot", async () => {
  let observations = 0;
  const delivered = await awaitPurchasedResult({
    receipt: { result: "https://provider.example/result/paid" },
    pollIntervalMs: 1,
    fetchImpl: async () => Response.json(observations++ === 0
      ? { status: "pending" }
      : { status: "terminal", terminal: { type: "DeliveredLot", result: 3 } }),
  });
  assert.equal(observations, 2);
  assert.equal(delivered.delivery.result, 3);
});
