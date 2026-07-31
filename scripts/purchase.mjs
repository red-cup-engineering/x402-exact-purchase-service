#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import {
  openEnterpriseAccountPayer,
  purchaseAndAwaitExactResource,
} from "../src/purchase.mjs";

function option(name) {
  const at = process.argv.indexOf(name);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (typeof value !== "string" || value === "") throw new Error(`${name} is required`);
  return value;
}

const payer = await openEnterpriseAccountPayer({
  deploymentManifestPath: option("--deployment-manifest"),
  accountBindingPath: option("--account-binding"),
  keystorePath: option("--keystore"),
  passwordFile: option("--password-file"),
});
const receipt = await purchaseAndAwaitExactResource({
  url: option("--url"),
  body: JSON.parse(await readFile(option("--input"), "utf8")),
  sturdyRef: (await readFile(option("--sturdyref-file"), "utf8")).trim(),
  payer,
  network: option("--network"),
  rpcUrl: option("--rpc-url"),
  maximumAmount: option("--maximum-amount"),
});
process.stdout.write(`${JSON.stringify(receipt)}\n`);
