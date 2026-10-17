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

test("A2A command executes quote-only owner without importing a wallet and refuses paid fallback", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { Message, Role } = await import("@a2a-js/sdk");
  const { userRmnMessage, extractRmnPart } = await import("@red-cup-engineering/a2a-rmn-part-service");
  const { semanticBytes, decodeSemantic } = await import("@red-cup-engineering/relation-model-notation-cbor-codec");
  const root = await mkdtemp(join(tmpdir(), "x402-quote-only-"));
  const ownerPath = join(root, "owner.mjs");
  const header = encodePaymentRequiredHeader({
    x402Version: 2, resource: { url }, accepts: [terms],
  });
  await writeFile(ownerPath, `
export function admitPurchase() {
  return { url: ${JSON.stringify(url)}, method: "POST",
    body: { simple: true }, network: ${JSON.stringify(network)},
    asset: ${JSON.stringify(asset)}, maximumAmount: "7",
    expectedPayTo: ${JSON.stringify(payTo)} };
}
export async function quoteFetch(target, init) {
  if (target !== ${JSON.stringify(url)} || init.method !== "POST"
      || new Headers(init.headers).has("payment-signature")) {
    throw new TypeError("quote egress policy violated");
  }
  return new Response("", { status: 402, headers: { "payment-required": ${JSON.stringify(header)} } });
}
`);
  const invoke = async (actorRequest) => {
    const message = userRmnMessage(semanticBytes(actorRequest));
    message.contextId = "existing-context";
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("../scripts/execute-a2a-message.mjs", import.meta.url)),
      "--owner-module", ownerPath,
    ]);
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    const terminal = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    child.stdin.end(JSON.stringify(message));
    const exitCode = await terminal;
    return { exitCode, stdout, stderr };
  };
  try {
    const result = await invoke(request());
    assert.equal(result.exitCode, 0, result.stderr);
    const response = Message.fromJSON(JSON.parse(result.stdout));
    assert.equal(response.role, Role.ROLE_AGENT);
    assert.equal(response.contextId, "existing-context");
    const output = decodeSemantic(extractRmnPart(response.parts).bytes);
    assert.equal(output.type, "X402HttpQuoteResult");
    assert.equal(output.result.requirement.amount, "7");
    assert.equal(output.result.authority.paymentAttempted, false);
    const purchaseBody = {
      type: "X402HttpPurchaseRequest", provider: ACTOR,
      purchase: { url, network, asset, maximumAmount: "7" },
    };
    const paid = await invoke({ id: semanticId(purchaseBody), ...purchaseBody });
    assert.notEqual(paid.exitCode, 0);
    assert.match(paid.stderr, /paid x402 A2A request requires owner.openPayer/u);
    assert.equal(paid.stdout, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
