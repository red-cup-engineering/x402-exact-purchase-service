#!/usr/bin/env node
// project-successor-activation-records — write a capability cell's successor activation
// projection into its package, reporting which records changed. Run directly for this
// service's cell; other cells call materializeSuccessorActivation with their own.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectSuccessorActivation, x402ExactPurchaseCell } from "../src/successor-activation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const canonicalDeployment = path.resolve(here,
  "../../../../../../computer-systems-engineering-services-section/services/computer-blockchain-system-services-section/services/ethereum-engineering-services-section/data/records/deployment-records/eip155-5615611-semiotic-exchange.json");

function option(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
async function json(target) { return JSON.parse(await readFile(target, "utf8")); }
async function optionalJson(target) { return target === undefined ? undefined : json(target); }

export async function materializeSuccessorActivation(cell, packageRoot) {
  const root = path.resolve(option("--root") ?? packageRoot);
  const projection = projectSuccessorActivation(cell, {
    deployment: await json(path.resolve(option("--deployment") ?? canonicalDeployment)),
    accountBinding: await json(path.resolve(option("--account-binding") ?? path.join(root, "content/evm/accounts/eip155-5615611.json"))),
    x402Binding: await json(path.resolve(option("--x402-binding") ?? path.join(root, "content/x402/eip155-5615611.json"))),
    agentCardTemplate: await json(path.resolve(option("--agent-card-template") ?? path.join(root, cell.agentCardPath))),
    offerSigningReceipt: await optionalJson(option("--offer-signing-receipt")),
  });
  const changed = [];
  const unchanged = [];
  for (const [relative, record] of Object.entries(projection.outputs)) {
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("projection target escaped the package root");
    const source = `${JSON.stringify(record, null, 2)}\n`;
    let previous;
    try { previous = await readFile(target, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (previous === source) { unchanged.push(relative); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source, { encoding: "utf8", mode: 0o644 });
    changed.push(relative);
  }
  process.stdout.write(`${JSON.stringify({ type: "SuccessorActivationMaterializationReceipt", projection: projection.id,
    nodeId: projection.nodeId, changed, unchanged, networkCalls: 0 })}\n`);
}

if (import.meta.main) await materializeSuccessorActivation(x402ExactPurchaseCell, path.resolve(here, ".."));
