import assert from "node:assert/strict";
import test from "node:test";
import { semanticBytes, decodeSemantic, semanticId } from "@red-cup-engineering/computer-content-address-engineering-services-section/semiotic-content-address";
import { ACTOR, executeOperation, executeA2aMessage } from "../src/a2a-executor.mjs";

test("a provider-addressed HTTP request crosses the native actor boundary with owner-held payer and book hooks", async () => {
  const body = { type: "X402HttpPurchaseRequest", provider: ACTOR,
    purchase: { url: "https://ordinary.example/data", network: "eip155:8453",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", maximumAmount: "70000000",
      payer: { caip10: "forged" }, beforePayment: "forged", onSettlement: "forged" } };
  const request = { id: semanticId(body), ...body };
  const payer = { caip10: "owner" }, beforePayment = () => {}, onSettlement = () => {}, onDelivery = () => {};
  let received;
  const output = await executeOperation(request, { payer, beforePayment, onSettlement, onDelivery,
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
  assert.equal(received.onDelivery, onDelivery);
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


test("an independently received SEN reply preserves owner pricing and the observed native HTTP exchange", async () => {
  const { createServer } = await import("node:http");
  const { purchaseHttpResource } = await import("../src/purchase.mjs");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } = await import("@x402/core/http");
  const { userSenMessage, admitSenMessage, ROLE_AGENT } = await import("@red-cup-engineering/a2a-services-section/sen-part");
  // Public development key; this carrier assay neither settles nor uses funds.
  const signer = privateKeyToAccount("0x" + "1".padStart(64, "0"));
  const network = "eip155:8453", asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const terms = { scheme: "exact", network, asset, amount: "7",
    payTo: "0x2222222222222222222222222222222222222222", maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" } };
  const transaction = "0x" + "a".repeat(64), events = [];
  let url, calls = 0, signedAmount;
  const server = createServer((req, res) => {
    calls++;
    if (!req.headers["payment-signature"]) {
      res.writeHead(402, { "payment-required": encodePaymentRequiredHeader({
        x402Version: 2, resource: { url, mimeType: "application/octet-stream" }, accepts: [terms],
      }) }); res.end(); return;
    }
    signedAmount = decodePaymentSignatureHeader(req.headers["payment-signature"]).payload.authorization.value;
    events.push("signed request received");
    res.writeHead(200, { "content-type": "application/octet-stream",
      "payment-response": encodePaymentResponseHeader({ success: true, network, transaction, payer: signer.address }) });
    res.end(Buffer.from([0, 255, 42]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    url = "https://ordinary.example/resource";
    const loopback = `http://127.0.0.1:${server.address().port}/resource`;
    const body = { type: "X402HttpPurchaseRequest", provider: ACTOR,
      purchase: { url, network, asset, maximumAmount: "70000000" } };
    const request = { id: semanticId(body), ...body };
    const message = { ...userSenMessage(semanticBytes(request)), contextId: "original-context", taskId: "original-task" };
    const output = await executeA2aMessage(message, {
      // Test transport routes the declared HTTPS resource to the loopback seller.
      purchaseHttpResource: options => purchaseHttpResource({ ...options, fetchImpl: (_resource, init) => fetch(loopback, init) }),
      admitPurchase: proposal => {
        assert.equal(proposal.purchase.maximumAmount, "70000000");
        events.push("owner admitted");
        message.contextId = "substituted-context";
        request.purchase.maximumAmount = "90000000";
        return { url, network, asset, maximumAmount: "7" };
      },
      openPayer: admitted => {
        assert.equal(admitted.maximumAmount, "7"); events.push("owner wallet opened");
        return { signer, network, caip10: `${network}:${signer.address}` };
      },
      beforePayment: intent => { events.push("signed intent retained"); assert.equal(intent.paymentPayload.accepted.amount, "7"); },
      onSettlement: observation => { events.push("settlement report retained"); assert.equal(observation.settlement.transaction, transaction); },
      onDelivery: observation => { events.push("delivery hash retained"); assert.equal(observation.delivery.bytes, 3); assert.equal("body" in observation.delivery,false); },
    });
    const received = admitSenMessage(JSON.parse(JSON.stringify(output)), { role: ROLE_AGENT });
    const result = decodeSemantic(received.part.bytes);
    assert.equal(output.contextId, "original-context"); assert.equal(output.taskId, "original-task");
    assert.equal(output.metadata.outputNi, received.part.ni);
    assert.equal(result.request, request.id); assert.equal(result.result.customer, `${network}:${signer.address}`);
    assert.equal(result.result.requirement.amount, "7"); assert.equal(result.result.delivery.body, "AP8q");
    assert.equal(result.result.settlement.transaction, transaction);
    assert.equal(signedAmount, "7"); assert.equal(calls, 2);
    assert.deepEqual(events, ["owner admitted", "owner wallet opened", "signed intent retained", "signed request received", "settlement report retained", "delivery hash retained"]);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
