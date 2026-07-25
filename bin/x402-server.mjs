#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import express from "express";
import {
  createExactEvmPaymentBoundary,
  x402PaymentIdentity,
  x402SettlementEvidence,
} from "@emsenn/x402-services-section";
import {
  openEnterpriseAccountPayer,
  purchaseAndAwaitExactResource,
} from "../src/purchase.mjs";

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function quote() {
  const response = await fetch(required("PRICE_QUOTE_URL"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(await jsonFile(required("PRICE_QUOTE_DEMAND"))),
  });
  const body = await response.json();
  if (!response.ok || body?.ok !== true) throw new Error(`pricing provider refused: ${body?.refusal?.message ?? response.status}`);
  const amount = body.result?.consideration?.amount;
  if (amount?.denominator !== "1" || !/^[1-9][0-9]*$/u.test(amount.numerator ?? "")) {
    throw new Error("x402 seller boundary requires a positive integer atomic quote");
  }
  return Object.freeze({ result: body.result, atomicAmount: amount.numerator });
}

async function appendReceipt(path, record) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function terminalReceipts(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  return new Map(source.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((record) => ["X402PaidExactPurchaseReceipt", "X402PaidExactPurchaseRefusal"].includes(record?.type))
    .map((record) => [record.invocation, record]));
}

export async function main() {
  const network = required("SETTLEMENT_CAIP2");
  const settlement = required("SETTLEMENT_ACCOUNT");
  const asset = required("X402_ASSET");
  const resource = "/x402/x402-exact-purchase/invoke";
  const receiptPath = required("X402_RECEIPT_PATH");
  const priced = await quote();
  const offer = await jsonFile(required("CAPABILITY_OFFER_PATH"));
  if (offer.price.amount !== priced.atomicAmount || offer.price.network !== network
      || offer.price.asset.toLowerCase() !== asset.toLowerCase()
      || offer.price.payTo?.toLowerCase() !== settlement.split(":").at(-1).toLowerCase()) {
    throw new Error("published offer drifted from the hired pricing provider");
  }
  const payer = await openEnterpriseAccountPayer({
    accountBindingPath: required("ACCOUNT_BINDING"),
    keystorePath: required("ACCOUNT_KEYSTORE"),
    passwordFile: required("ACCOUNT_PASSWORD_FILE"),
  });
  if (payer.caip10.toLowerCase() !== settlement.toLowerCase()) {
    throw new Error("purchase payer and seller settlement account must be the same cell controller");
  }
  const pending = new Map();
  const terminal = await terminalReceipts(receiptPath);
  const boundary = createExactEvmPaymentBoundary({
    network,
    facilitatorUrl: required("X402_FACILITATOR_URL"),
    routes: {
      [`POST ${resource}`]: {
        accepts: [{
          scheme: "exact",
          network,
          price: {
            amount: priced.atomicAmount,
            asset,
            extra: { name: required("X402_ASSET_NAME"), version: required("X402_ASSET_VERSION") },
          },
          payTo: settlement.split(":").at(-1),
        }],
        description: "Buy one exact-EVM x402 resource as this cell's enterprise account.",
      },
    },
    afterSettle: async (event) => {
      const settlementEvidence = x402SettlementEvidence(event);
      const invocation = settlementEvidence.invocation;
      const intent = pending.get(invocation);
      if (!intent) throw new Error("settled payment has no exact purchase intent");
      await appendReceipt(receiptPath, { type: "X402ExactPurchaseSettlementReceipt", invocation, settlement: settlementEvidence, pricing: priced.result });
      try {
        const result = await purchaseAndAwaitExactResource({
          ...intent.request,
          payer,
          fetchImpl: globalThis.fetch,
        });
        const receipt = { type: "X402PaidExactPurchaseReceipt", invocation, result };
        terminal.set(invocation, receipt);
        await appendReceipt(receiptPath, receipt);
      } catch (error) {
        const refusal = { type: "X402PaidExactPurchaseRefusal", invocation, reason: error instanceof Error ? error.message : String(error) };
        terminal.set(invocation, refusal);
        await appendReceipt(receiptPath, refusal);
      } finally {
        pending.delete(invocation);
      }
    },
  });
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "1mb" }));
  app.get("/x402/x402-exact-purchase/offer", (_request, response) => response.json({ ...offer, pricing: priced.result }));
  app.post(resource, async (request, response, next) => {
    try {
      const authorization = request.get("authorization") ?? "";
      const matched = /^OCapN (urn:ocapn:sturdyref:[A-Za-z0-9_-]{43})$/u.exec(authorization);
      if (!matched) throw new Error("one OCapN sturdy reference is required");
      const admitted = await fetch(required("OCAPN_ADMISSION_URL"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sturdyRef: matched[1], locus: "purchase-x402-exact-resource" }),
      }).then((result) => result.json());
      if (admitted?.admitted !== true) throw new Error(`OCapN provider refused: ${admitted?.reason ?? "unknown"}`);
      await appendReceipt(receiptPath, { type: "OCapNAdmissionReceipt", operation: "purchase-x402-exact-resource", admission: admitted });
      next();
    } catch (error) {
      response.status(403).json({ ok: false, refusal: { type: "OCapNSturdyRefAdmissionRefusal", reason: error.message } });
    }
  });
  app.use(boundary.middleware);
  app.post(resource, async (request, response) => {
    const invocation = x402PaymentIdentity(request.get("payment-signature"));
    const intent = { type: "X402PaidExactPurchaseIntent", invocation, request: structuredClone(request.body) };
    await appendReceipt(receiptPath, intent);
    pending.set(invocation, intent);
    response.status(202).json({ ok: true, invocation, status: "settlement-pending", result: `/x402/x402-exact-purchase/result/${invocation.slice(7)}` });
  });
  app.get("/x402/x402-exact-purchase/result/:id", (request, response) => {
    if (!/^[0-9a-f]{64}$/u.test(request.params.id)) return response.status(400).json({ ok: false, refusal: { type: "InvalidInvocationIdentity" } });
    const invocation = `sha256:${request.params.id}`;
    return response.status(terminal.has(invocation) ? 200 : 202).json({ ok: true, invocation, status: terminal.has(invocation) ? "terminal" : "pending", terminal: terminal.get(invocation) ?? null });
  });
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "15632");
  app.listen(port, host, () => process.stdout.write(`${JSON.stringify({ type: "X402ExactPurchaseSellerListening", host, port, network, atomicAmount: priced.atomicAmount })}\n`));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
