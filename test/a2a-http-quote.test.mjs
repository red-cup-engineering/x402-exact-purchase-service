import assert from "node:assert/strict";
import test from "node:test";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { semanticId } from "@red-cup-engineering/relation-model-notation-cbor-codec";
import { ACTOR, executeOperation } from "../src/a2a-executor.mjs";

const url = "https://merchant.example/x402/post";
const network = "eip155:8453";
const asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const payTo = "0x2222222222222222222222222222222222222222";
const terms = {
  scheme: "exact", network, asset, payTo, amount: "7",
  maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
};
function request() {
  const body = {
    type: "X402HttpQuoteRequest", provider: ACTOR,
    purchase: {
      url, network, asset, maximumAmount: "999999",
      payer: { caip10: "untrusted" }, onSettlement: "untrusted",
    },
  };
  return { id: semanticId(body), ...body };
}

test("A2A quote resolves an exact owner-approved POST without opening signer or purchasing", async () => {
  let opens = 0, fetches = 0;
  const actor = await executeOperation(request(), {
    admitPurchase: proposal => {
      assert.equal(proposal.purchase.maximumAmount, "999999");
      return { url, method: "POST", body: { request: "science" },
        network, asset, maximumAmount: "7", expectedPayTo: payTo };
    },
    openPayer: () => { opens++; throw new Error("quote must not open wallet"); },
    quoteFetch: async (_url, init) => {
      fetches++;
      assert.equal(init.method, "POST");
      assert.equal(init.body, JSON.stringify({ request: "science" }));
      assert.equal(new Headers(init.headers).has("payment-signature"), false);
      return new Response("", { status: 402, headers: {
        "payment-required": encodePaymentRequiredHeader({
          x402Version: 2, resource: { url }, accepts: [terms],
        }),
      } });
    },
  });
  assert.equal(opens, 0);
  assert.equal(fetches, 1);
  assert.equal(actor.type, "X402HttpQuoteResult");
  assert.equal(actor.request, request().id);
  assert.equal(actor.result.requirement.amount, "7");
  assert.equal(actor.result.maximumAmount, "7");
  assert.equal(actor.result.authority.signingAttempted, false);
  assert.equal(actor.result.authority.settlementObserved, false);
  assert.equal(actor.result.delivery, undefined);
  const { id, ...body } = actor;
  assert.equal(id, semanticId(body), "the actor output retains one canonical content identity");
});

test("quote-only actors must have owner admission and explicit safe egress, not wallet credentials", async () => {
  let fetches = 0, opens = 0;
  const options = {
    openPayer: () => { opens++; throw new Error("wallet opened"); },
    quoteFetch: async () => { fetches++; throw new Error("egress"); },
  };
  await assert.rejects(executeOperation(request(), options), /actor owner must admit/u);
  await assert.rejects(executeOperation(request(), {
    ...options, admitPurchase: () => ({
      url, network, asset, maximumAmount: "7",
    }), quoteFetch: undefined,
  }), /egress-safe quoteFetch/u);
  await assert.rejects(executeOperation(request(), {
    ...options, admitPurchase: () => { throw new Error("owner refuses quote"); },
  }), /owner refuses quote/u);
  assert.equal(fetches, 0);
  assert.equal(opens, 0);
});
