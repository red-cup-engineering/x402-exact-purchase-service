#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeA2aMessage } from "../src/a2a-executor.mjs";
try {
  const at = process.argv.indexOf("--owner-module");
  const path = at < 0 ? process.env.X402_OWNER_MODULE : process.argv[at + 1];
  if (typeof path !== "string" || !path) throw new Error("--owner-module or X402_OWNER_MODULE must name the actor owner's purchase admission and wallet module");
  const owner = await import(pathToFileURL(resolve(path)).href);
  if (typeof owner.admitPurchase !== "function"
      || (owner.openPayer !== undefined && typeof owner.openPayer !== "function")
      || (owner.quoteFetch !== undefined && typeof owner.quoteFetch !== "function")
      || (owner.purchaseFetch !== undefined && typeof owner.purchaseFetch !== "function")) {
    throw new TypeError("owner module must export admitPurchase and valid optional openPayer/quoteFetch functions");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new RangeError("A2A purchase proposal exceeds 1 MiB");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(`${JSON.stringify(await executeA2aMessage(input, {
    admitPurchase: owner.admitPurchase,
    // Quote-only modules do not need keys; paid requests MUST NOT fall back to
    // environment-based private-wallet opening when that export is missing.
    openPayer: owner.openPayer ?? (() => {
      throw new TypeError("paid x402 A2A request requires owner.openPayer");
    }),
    quoteFetch: owner.quoteFetch,
    purchaseFetch: owner.purchaseFetch,
    beforePayment: owner.beforePayment, onSettlement: owner.onSettlement, onDelivery: owner.onDelivery,
  }))}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
