import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectX402SuccessorActivation } from "../src/successor-activation.mjs";

const deploymentUrl = new URL("../../../../../../blockchain-services-section/services/ethereum-services-section/data/deployments/eip155-5615611-semiotic-exchange.json", import.meta.url);
const deployment = JSON.parse(await readFile(deploymentUrl, "utf8"));
const card = JSON.parse(await readFile(new URL("../content/agent-cards/x402-exact-purchase.json", import.meta.url), "utf8"));
const factory = "0x402616b746c56deb665bd163f32ec4b8e7dc0916";
const exchange = "0xc4234dc42c9d93bc7d61b0354aba2729ae52e322";

function account(address = `0x${"a".repeat(40)}`) {
  return { profile: "org.emsenn.evm.sovereign-enterprise-account.v3",
    enterprise: { nodeId: "x402-exact-purchase-service", urn: "urn:ame:x402-exact-purchase-service",
      enterpriseId: `0x${"1".repeat(64)}` }, chain: { chainId: 5615611, caip2: "eip155:5615611" },
    account: { address, caip10: `eip155:5615611:${address}` },
    factory: { address: factory, userSalt: `0x${"2".repeat(64)}` },
    policy: { signer: `0x${"3".repeat(40)}`, custody: "remote-cloud-kms-hsm", keyVersion: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1" },
    deployment: { transaction: `0x${"4".repeat(64)}`, block: 72 } };
}

function economic(payTo = `0x${"a".repeat(40)}`) {
  return { type: "SuccessorX402Binding", network: "eip155:5615611", exchange,
    facilitatorUrl: "https://facilitator.example.test", asset: `0x${"5".repeat(40)}`,
    payTo, assetName: "Successor Credit", assetVersion: "1", amount: "51" };
}

test("activation refuses missing or unverified successor bindings", () => {
  assert.throws(() => projectX402SuccessorActivation({ deployment, agentCardTemplate: card }), /EnterpriseAccountBinding/u);
  assert.throws(() => projectX402SuccessorActivation({ deployment, accountBinding: account(), agentCardTemplate: card }), /SuccessorX402Binding/u);
  assert.throws(() => projectX402SuccessorActivation({ deployment, accountBinding: account(), x402Binding: economic(`0x${"b".repeat(40)}`), agentCardTemplate: card }), /SuccessorX402Binding/u);
});

test("projects exact successor identity, offer, residuals, and x402 outbox", () => {
  const projected = projectX402SuccessorActivation({ deployment, accountBinding: account(), x402Binding: economic(), agentCardTemplate: card });
  const offer = projected.outputs["content/offers/current.json"];
  assert.deepEqual(offer.price, { protocol: "x402", scheme: "exact", network: "eip155:5615611",
    asset: `0x${"5".repeat(40)}`, amount: "51", payTo: `0x${"a".repeat(40)}`,
    facilitator: "https://facilitator.example.test", extra: { name: "Successor Credit", version: "1" } });
  assert.equal(offer.signing.status, "unsigned-candidate");
  assert.equal(projected.outputs["content/capcell/customer-invocation.json"].state, "idle");
  assert.equal(projected.outputs["content/health/current.json"].state, "configured-not-live-observed");
  assert.equal(projected.outputs["content/activitypub/outbox.json"][0].object.liveObservationClaimed, false);
});

test("repeat projection is byte-for-byte idempotent", () => {
  const first = projectX402SuccessorActivation({ deployment, accountBinding: account(), x402Binding: economic(), agentCardTemplate: card });
  const second = projectX402SuccessorActivation({ deployment, accountBinding: account(), x402Binding: economic(),
    agentCardTemplate: first.outputs["content/agent-cards/x402-exact-purchase.json"] });
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("owning materializer reports a complete repeat as unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "x402-successor-activation-"));
  const put = async (relative, value) => {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
  };
  try {
    await put("content/evm/accounts/eip155-5615611.json", account());
    await put("content/x402/eip155-5615611.json", economic());
    await put("content/agent-cards/x402-exact-purchase.json", card);
    const script = fileURLToPath(new URL("../scripts/project-successor-activation-records.mjs", import.meta.url));
    const args = [script, "--root", root, "--deployment", fileURLToPath(deploymentUrl)];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).changed.length, 8);
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    const receipt = JSON.parse(second.stdout);
    assert.equal(receipt.changed.length, 0);
    assert.equal(receipt.unchanged.length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed verified controller readdresses all content-addressed active identities", () => {
  const first = projectX402SuccessorActivation({ deployment, accountBinding: account(), x402Binding: economic(), agentCardTemplate: card });
  const nextAddress = `0x${"b".repeat(40)}`;
  const second = projectX402SuccessorActivation({ deployment, accountBinding: account(nextAddress), x402Binding: economic(nextAddress), agentCardTemplate: card });
  for (const path of ["content/capcell/identity.json", "content/capcell/manifest.json", "content/offers/current.json"]) {
    assert.notEqual(second.outputs[path].id, first.outputs[path].id);
  }
  assert.notEqual(second.outputs["content/activitypub/outbox.json"][0].id, first.outputs["content/activitypub/outbox.json"][0].id);
});

test("successor projection contains no predecessor identity or economic term", () => {
  const projected = projectX402SuccessorActivation({ deployment, accountBinding: account(), x402Binding: economic(), agentCardTemplate: card });
  assert.equal(JSON.stringify(projected).includes("5615610"), false);
});
