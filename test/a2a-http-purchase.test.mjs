import assert from "node:assert/strict";
import test from "node:test";
import { semanticId } from "@red-cup-engineering/relation-model-notation-runtime";
import { ACTOR, executeOperation } from "../src/a2a-executor.mjs";

test("a provider-addressed HTTP request crosses the native actor boundary with owner-held payer and book hooks", async () => {
  const body = { type: "X402HttpPurchaseRequest", provider: ACTOR,
    purchase: { url: "https://ordinary.example/data", network: "eip155:8453",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", maximumAmount: "70000000",
      payer: { caip10: "forged" }, beforePayment: "forged", onSettlement: "forged" } };
  const request = { id: semanticId(body), ...body };
  const payer = { caip10: "owner" }, beforePayment = () => {}, onSettlement = () => {};
  let received;
  const output = await executeOperation(request, { payer, beforePayment, onSettlement,
    admitPurchase: proposal => {
      assert.equal(proposal.purchase.maximumAmount, "70000000");
      return { url: proposal.purchase.url, network: "eip155:8453",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", maximumAmount: "7" };
    },
    purchaseHttpResource: async options => { received = options; return { type: "X402HttpPurchaseReceipt", customer: payer.caip10 }; },
    openEnterpriseAccountPayer: () => { throw new Error("private exchange must not gate ordinary HTTP"); },
  });
  assert.equal(received.payer, payer);
  assert.equal(received.maximumAmount, "7");
  assert.equal(received.beforePayment, beforePayment);
  assert.equal(received.onSettlement, onSettlement);
  assert.equal(output.type, "X402HttpPurchaseResult");
  assert.equal(output.request, request.id);
  assert.equal(output.provider, ACTOR);
  const { id, ...value } = output;
  assert.equal(id, semanticId(value));
});


test("a canonical request is no spending authority and cannot open the owner's wallet", async () => {
  const body = { type: "X402HttpPurchaseRequest", provider: ACTOR,
    purchase: { url: "https://ordinary.example/data", network: "eip155:8453",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", maximumAmount: "7" } };
  const request = { id: semanticId(body), ...body };
  let opened = 0, executed = 0;
  const options = { openPayer: () => { opened++; }, purchaseHttpResource: () => { executed++; } };
  await assert.rejects(executeOperation(request, options), /actor owner must admit/);
  await assert.rejects(executeOperation(request, { ...options,
    admitPurchase: () => { throw new Error("owner refuses this demand"); } }), /owner refuses/);
  await assert.rejects(executeOperation(request, {
    admitPurchase: proposal => proposal.purchase,
    openEnterpriseAccountPayer: () => { opened++; },
  }), /actor owner’s payer or wallet opener/);
  assert.equal(opened, 0); assert.equal(executed, 0);
});
