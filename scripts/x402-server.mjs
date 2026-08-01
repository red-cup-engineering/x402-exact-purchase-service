#!/usr/bin/env node

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import express from "express";
import {
  createExactEvmPaymentBoundary,
  x402PaymentIdentity,
  x402SettlementEvidence,
} from "@red-cup-engineering/x402-services-section";
import {
  assertTerminalSettlementEvidence,
  openEnterpriseAccountPayer,
  purchaseAndAwaitExactResource,
} from "../src/purchase.mjs";
import {
  loadSuccessorX402Binding,
  requireActiveSuccessorRecord,
} from "../src/successor-deployment.mjs";

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

async function receiptState(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { intents: new Map(), settlements: new Map(), terminal: new Map() };
    throw error;
  }
  const records = source.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return {
    intents: new Map(records
      .filter((record) => record?.type === "X402PaidExactPurchaseIntent")
      .map((record) => [record.invocation, record])),
    settlements: new Map(records
      .filter((record) => record?.type === "X402ExactPurchaseSettlementReceipt")
      .map((record) => [record.invocation, record])),
    terminal: new Map(records
      .filter((record) => [
        "X402PaidExactPurchaseReceipt",
        "X402PaidExactPurchaseRecoveryReceipt",
        "X402PaidExactPurchaseRefusal",
      ].includes(record?.type))
      .map((record) => [record.invocation, record])),
  };
}

export async function main() {
  const payer = await openEnterpriseAccountPayer({
    deploymentManifestPath: process.env.EVM_DEPLOYMENT_MANIFEST,
    accountBindingPath: process.env.ACCOUNT_BINDING,
    keystorePath: process.env.ACCOUNT_KEYSTORE,
    passwordFile: process.env.ACCOUNT_PASSWORD_FILE,
  });
  const network = payer.network;
  const settlement = payer.caip10;
  const economic = await loadSuccessorX402Binding({
    path: process.env.X402_BINDING,
    deployment: {
      chain: payer.network,
      exchange: payer.exchange,
    },
    account: payer.caip10,
    nodeId: "x402-exact-purchase-service",
  });
  const asset = economic.asset;
  const resource = "/x402/x402-exact-purchase/invoke";
  const receiptPath = required("X402_RECEIPT_PATH");
  const priced = await quote();
  const offer = requireActiveSuccessorRecord(
    await jsonFile(required("CAPABILITY_OFFER_PATH")),
    "org.emsenn.capability-offer.v3",
    "x402-exact-purchase-service",
  );
  if (offer.price.amount !== priced.atomicAmount || offer.price.network !== network
      || offer.price.asset.toLowerCase() !== asset.toLowerCase()
      || offer.price.payTo?.toLowerCase() !== settlement.split(":").at(-1).toLowerCase()) {
    throw new Error("published offer drifted from the hired pricing provider");
  }
  const downstreamSturdyRef = (await readFile(required("DOWNSTREAM_OCAPN_STURDYREF_FILE"), "utf8")).trim();
  const downstreamRpcUrl = payer.rpc;
  const capabilityTerritory = required("CAPABILITY_TERRITORY");
  const recovered = await receiptState(receiptPath);
  const pending = new Map(recovered.intents);
  const settlements = new Map(recovered.settlements);
  const terminal = new Map(recovered.terminal);
  const running = new Set();
  async function executePaidIntent(invocation, intent, settlementEvidence, recovery = false) {
    if (running.has(invocation)) throw new Error("paid obligation is already executing");
    running.add(invocation);
    try {
      const request = structuredClone(intent.request);
      request.sturdyRef = downstreamSturdyRef;
      request.rpcUrl = downstreamRpcUrl;
      if (request.body && typeof request.body === "object" && request.body.territory === undefined) {
        request.body.territory = capabilityTerritory;
      }
      const result = await purchaseAndAwaitExactResource({
        ...request,
        payer,
        fetchImpl: globalThis.fetch,
      });
      const receipt = {
        type: recovery ? "X402PaidExactPurchaseRecoveryReceipt" : "X402PaidExactPurchaseReceipt",
        invocation,
        settlement: settlementEvidence,
        settlementEvidence: result.delivery.settlementEvidence,
        result,
      };
      terminal.set(invocation, receipt);
      await appendReceipt(receiptPath, receipt);
    } catch (error) {
      const refusal = {
        type: "X402PaidExactPurchaseRefusal",
        invocation,
        settlement: settlementEvidence,
        reason: error instanceof Error ? error.message : String(error),
      };
      terminal.set(invocation, refusal);
      await appendReceipt(receiptPath, refusal);
    } finally {
      running.delete(invocation);
    }
  }
  async function recoverFromDeliveredDownstream(invocation, intent, settlementEvidence, deliveredResult) {
    if (running.has(invocation)) throw new Error("paid obligation is already executing");
    running.add(invocation);
    try {
      const resultUrl = new URL(deliveredResult);
      const downstreamInvoke = new URL(intent.request.url);
      const expectedPrefix = downstreamInvoke.pathname.replace(/\/invoke$/u, "/result/");
      if (resultUrl.protocol !== "https:" || resultUrl.origin !== downstreamInvoke.origin
          || !resultUrl.pathname.startsWith(expectedPrefix)) {
        throw new Error("downstream recovery result is outside the purchased resource result boundary");
      }
      const response = await fetch(resultUrl, { headers: { accept: "application/json" } });
      const observed = await response.json();
      const delivered = observed?.terminal;
      if (!response.ok || observed?.status !== "terminal"
          || !["X402PaidSoftwareMissionReceipt", "X402PaidSoftwareMissionRecoveryReceipt"].includes(delivered?.type)
          || delivered?.settlement?.success !== true
          || delivered?.invocation !== observed?.invocation) {
        throw new Error("downstream recovery result does not prove one settled terminal delivery");
      }
      const offerUrl = new URL("./offer", downstreamInvoke);
      const offerResponse = await fetch(offerUrl, { headers: { accept: "application/json" } });
      const offer = await offerResponse.json();
      if (!offerResponse.ok || offer.price?.network !== intent.request.network
          || !/^[1-9][0-9]*$/u.test(offer.price?.amount ?? "")
          || BigInt(offer.price.amount) > BigInt(intent.request.maximumAmount)) {
        throw new Error("downstream recovery offer does not match the admitted purchase boundary");
      }
      const result = {
        type: "X402ExactPurchaseReceipt",
        customer: payer.caip10,
        exchange: {
          network: payer.network,
          address: payer.exchange,
          deploymentBlock: payer.deploymentBlock,
        },
        resource: intent.request.url,
        requirement: {
          scheme: "exact",
          network: offer.price.network,
          amount: offer.price.amount,
          asset: offer.price.asset,
          payTo: offer.price.payTo,
        },
        invocation: delivered.invocation,
        result: resultUrl.href,
        settlement: delivered.settlement,
        delivery: delivered,
      };
      assertTerminalSettlementEvidence(result, delivered);
      const receipt = {
        type: "X402PaidExactPurchaseRecoveryReceipt",
        invocation,
        settlement: settlementEvidence,
        settlementEvidence: delivered.settlementEvidence,
        result,
      };
      terminal.set(invocation, receipt);
      await appendReceipt(receiptPath, receipt);
    } catch (error) {
      const refusal = {
        type: "X402PaidExactPurchaseRefusal",
        invocation,
        settlement: settlementEvidence,
        reason: error instanceof Error ? error.message : String(error),
      };
      terminal.set(invocation, refusal);
      await appendReceipt(receiptPath, refusal);
    } finally {
      running.delete(invocation);
    }
  }
  const boundary = createExactEvmPaymentBoundary({
    network,
    facilitatorUrl: economic.facilitatorUrl,
    routes: {
      [`POST ${resource}`]: {
        accepts: [{
          scheme: "exact",
          network,
          price: {
            amount: priced.atomicAmount,
            asset,
            extra: { name: economic.assetName, version: economic.assetVersion },
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
      const settlementReceipt = { type: "X402ExactPurchaseSettlementReceipt", invocation, settlement: settlementEvidence, pricing: priced.result };
      settlements.set(invocation, settlementReceipt);
      await appendReceipt(receiptPath, settlementReceipt);
      await executePaidIntent(invocation, intent, settlementEvidence);
    },
  });
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT ?? "1mb" }));
  app.get("/x402/x402-exact-purchase/offer", (_request, response) => response.json({ ...offer, pricing: priced.result }));
  async function admitCustomerAuthority(request, response, next) {
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
  }
  app.post(resource, admitCustomerAuthority);
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
    const recoveryPending = running.has(invocation);
    const isTerminal = terminal.has(invocation) && !recoveryPending;
    return response.status(isTerminal ? 200 : 202).json({
      ok: true,
      invocation,
      status: recoveryPending ? "recovery-pending" : isTerminal ? "terminal" : "pending",
      terminal: isTerminal ? terminal.get(invocation) : null,
    });
  });
  app.post("/x402/x402-exact-purchase/recover/:id", admitCustomerAuthority, (request, response) => {
    if (!/^[0-9a-f]{64}$/u.test(request.params.id)) {
      return response.status(400).json({ ok: false, refusal: { type: "InvalidInvocationIdentity" } });
    }
    const invocation = `sha256:${request.params.id}`;
    const intent = pending.get(invocation);
    const settlementReceipt = settlements.get(invocation);
    const prior = terminal.get(invocation);
    if (!intent || settlementReceipt?.settlement?.success !== true
        || prior?.type !== "X402PaidExactPurchaseRefusal") {
      return response.status(409).json({ ok: false, refusal: { type: "PaidObligationNotRecoverable" } });
    }
    if (running.has(invocation)) {
      return response.status(202).json({ ok: true, invocation, status: "recovery-pending" });
    }
    const deliveredResult = request.body?.deliveredResult;
    running.add(invocation);
    setImmediate(() => {
      running.delete(invocation);
      (deliveredResult === undefined
        ? executePaidIntent(invocation, intent, settlementReceipt.settlement, true)
        : recoverFromDeliveredDownstream(invocation, intent, settlementReceipt.settlement, deliveredResult))
        .catch((error) => process.stderr.write(`${error.stack ?? error.message}\n`));
    });
    return response.status(202).json({ ok: true, invocation, status: "recovery-started" });
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
