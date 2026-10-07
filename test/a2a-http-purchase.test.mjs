import assert from "node:assert/strict";
import test from "node:test";
import { semanticBytes, decodeSemantic, semanticId } from "@red-cup-engineering/relation-model-notation-cbor-codec";
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


test("the installed actor command returns an independently verified wire result and retains the owner's observations", async () => {
  const { createServer } = await import("node:http");
  const { spawn } = await import("node:child_process");
  const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { Message, Role } = await import("@a2a-js/sdk");
  const { userRmnMessage, extractRmnPart } = await import("@red-cup-engineering/a2a-rmn-part-service");
  const { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } = await import("@x402/core/http");
  const network = "eip155:8453", asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const url = "https://ordinary.example/resource", transaction = "0x" + "a".repeat(64);
  const terms = { scheme: "exact", network, asset, amount: "7", payTo: "0x" + "2".repeat(40),
    maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  const journal = [], server = createServer((request, response) => {
    if (!request.headers["payment-signature"]) {
      response.writeHead(402, { "payment-required": encodePaymentRequiredHeader({
        x402Version: 2, resource: { url, mimeType: "application/octet-stream" }, accepts: [terms],
      }) }); response.end(); return;
    }
    const payload = decodePaymentSignatureHeader(request.headers["payment-signature"]);
    journal.push(payload);
    response.writeHead(200, { "payment-response": encodePaymentResponseHeader({ success: true,
      network, transaction, payer: payload.payload.authorization.from }), "content-type": "application/octet-stream" });
    response.end(Buffer.from([0, 255, 42]));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = await mkdtemp(join(tmpdir(), "x402-owner-wire-"));
  try {
    const ownerPath = join(root, "owner.mjs"), bookPath = join(root, "owner-observations.jsonl");
    // Public development key and loopback facilitator report: no funds or settlement.
    await writeFile(ownerPath, `import { appendFileSync } from "node:fs";
import { privateKeyToAccount } from ${JSON.stringify(import.meta.resolve("viem/accounts"))};
const signer = privateKeyToAccount("0x" + "1".padStart(64,"0"));
const originalFetch = globalThis.fetch;
globalThis.fetch = (resource, init) => originalFetch(${JSON.stringify(`http://127.0.0.1:${server.address().port}/resource`)},init);
const retain = (phase,value) => appendFileSync(${JSON.stringify(bookPath)},JSON.stringify({phase,value})+"\\n");
export function admitPurchase(proposal) { retain("admission",proposal); return {url:${JSON.stringify(url)},network:${JSON.stringify(network)},asset:${JSON.stringify(asset)},maximumAmount:"7"}; }
export function openPayer(admitted) { retain("wallet",admitted); return {signer,network:${JSON.stringify(network)},caip10:${JSON.stringify(network)}+":"+signer.address}; }
export function beforePayment(intent) { retain("intent",intent); }
export function onSettlement(observation) { retain("settlement",observation); }
`);
    const body = { type: "X402HttpPurchaseRequest", provider: ACTOR,
      purchase: { url, network, asset, maximumAmount: "70000000" } };
    const request = { id: semanticId(body), ...body }, message = userRmnMessage(semanticBytes(request));
    message.contextId = "original-context"; message.taskId = "original-task";
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/execute-a2a-message.mjs", import.meta.url)), "--owner-module", ownerPath]);
    let stdout = "", stderr = "";
    child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
    const terminal = new Promise((resolve, reject) => { child.on("error",reject);child.on("exit",resolve); });
    child.stdin.end(JSON.stringify(message));
    assert.equal(await terminal, 0, stderr);
    const output = Message.fromJSON(JSON.parse(stdout)), received = extractRmnPart(output.parts);
    const result = decodeSemantic(received.bytes);
    assert.equal(output.role, Role.ROLE_AGENT); assert.ok(output.messageId);
    assert.equal(output.contextId,"original-context");assert.equal(output.taskId,"original-task");
    assert.equal(output.metadata.outputNi,received.ni);assert.equal(result.request,request.id);
    assert.equal(result.result.requirement.amount,"7");assert.equal(result.result.delivery.body,"AP8q");
    assert.equal(result.result.settlement.transaction,transaction);
    const book = (await readFile(bookPath,"utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(book.map(entry => entry.phase),["admission","wallet","intent","settlement"]);
    assert.equal(book[0].value.purchase.maximumAmount,"70000000");
    assert.equal(book[1].value.maximumAmount,"7");
    assert.equal(book[2].value.paymentPayload.accepted.amount,"7");
    assert.equal(book[3].value.settlement.transaction,transaction);
    assert.equal(journal.length,1);assert.equal(journal[0].payload.authorization.value,"7");
  } finally {
    server.closeAllConnections();await new Promise(resolve => server.close(resolve));
    await rm(root,{recursive:true,force:true});
  }
});
