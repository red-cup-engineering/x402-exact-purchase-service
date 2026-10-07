#!/usr/bin/env node
import { stat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { purchaseAndAwaitExactResource, purchaseHttpResource } from "../src/purchase.mjs";
function option(name, required = true) {
  const at = process.argv.indexOf(name);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (required && (typeof value !== "string" || value === "")) throw new Error(`${name} is required`);
  return value;
}
async function jsonInput(path) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > 65536) throw new TypeError("request must be a JSON file of at most 64 KiB");
  return JSON.parse(await readFile(path, "utf8"));
}
if (process.argv.includes("--help")) {
  process.stdout.write(`Standard HTTP purchase:
  purchase-x402-exact-resource --request REQUEST.json --payer-module MODULE.mjs
Request: url, method, optional body/headers, network, asset, maximumAmount.
Module: openPayer(request) returns { network, caip10, signer }; optional
beforePayment(intent) and onSettlement(receipt) retain evidence in the owner's books.
Returns exact body (base64), content type, size, SHA-256 and facilitator receipt.
Settlement does not certify delivery acceptance or independent chain verification.
One payment attempt is sent; no automatic retries.

Private exchange purchase:
  --payer-module MODULE.mjs (owner-held private-exchange wallet)
  --deployment-manifest FILE --account-binding FILE --keystore FILE
  --password-file FILE --url URL --input FILE --sturdyref-file FILE
  --network CAIP2 --rpc-url URL --asset ADDRESS --maximum-amount N
`);
} else if (option("--request", false)) {
  const request = await jsonInput(option("--request"));
  const owner = await import(pathToFileURL(resolve(option("--payer-module"))).href);
  if (typeof owner.openPayer !== "function") throw new TypeError("payer module must export openPayer(request)");
  const payer = await owner.openPayer(structuredClone(request));
  const receipt = await purchaseHttpResource({
    ...request, payer, beforePayment: owner.beforePayment, onSettlement: owner.onSettlement,
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} else {
  const owner = await import(pathToFileURL(resolve(option("--payer-module"))).href);
  if (typeof owner.openPayer !== "function") throw new TypeError("payer module must export openPayer(request)");
  const payer = await owner.openPayer({
    deploymentManifestPath: option("--deployment-manifest", false),
    accountBindingPath: option("--account-binding", false),
    keystorePath: option("--keystore", false), passwordFile: option("--password-file", false),
    network: option("--network"),
  });
  const receipt = await purchaseAndAwaitExactResource({
    url: option("--url"), body: await jsonInput(option("--input")),
    sturdyRef: (await readFile(option("--sturdyref-file"), "utf8")).trim(), payer,
    network: option("--network"), rpcUrl: option("--rpc-url"),
    maximumAmount: option("--maximum-amount"), asset: option("--asset"),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
