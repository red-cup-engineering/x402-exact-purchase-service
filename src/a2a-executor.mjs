import { randomUUID } from "node:crypto";
import { readHttpPurchaseQuote, requireOwnerPayee } from "./http-quote.mjs";
import { preflightHttpServiceChain, executeHttpServiceChain } from "./http-service-chain.mjs";
import { Message, Role } from "@a2a-js/sdk";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { decodeSemantic, semanticBytes, semanticId } from "@red-cup-engineering/relation-model-notation-cbor-codec";
import {
  openEnterpriseAccountPayer,
  purchaseHttpResource,
  purchaseAndAwaitExactResource,
} from "./purchase.mjs";

export const ACTOR = "urn:ame:x402-exact-purchase-service";

function record(body) {
  return Object.freeze({ id: semanticId(body), ...body });
}

function exact(value) {
  if (!value || typeof value !== "object") return false;
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "id"));
  return value.id === semanticId(body);
}

export async function executeOperation(source, options = {}) {
  const request = structuredClone(source);
  if (!exact(request) || request.provider !== ACTOR) {
    throw new Error("exact provider-addressed canonical SEN operation is required");
  }
  if (!["X402ExactPurchaseRequest", "X402HttpPurchaseRequest", "X402HttpQuoteRequest",
    "X402HttpServiceChainRequest"].includes(request.type) || !request.purchase ||
      typeof request.purchase !== "object" || Array.isArray(request.purchase)) {
    throw new Error("x402 exact purchase request requires one purchase");
  }
  if (typeof options.admitPurchase !== "function") {
    throw new Error("the actor owner must admit the purchase before its wallet is opened");
  }
  const admitted = structuredClone(await options.admitPurchase(structuredClone(request)));
  // Source-owned micro-enterprise chain, with its *own* A2A operation identity.
  // Owner admission yields original selected seller offers, per-cell grants and
  // a total cap; proposals can never mint a payee or grant wallet custody.
  if (request.type === "X402HttpServiceChainRequest") {
    const required = [
      "purchaseFetch", "validateInput", "validateOutput",
      "projectMarketOfferBody", "beforePayment", "onSettlement",
      "onDelivery", "onStage", "onFailure",
    ];
    if (required.some(name => typeof options[name] !== "function")) {
      throw new TypeError("Hoare service chain requires original source validators, owner-controlled egress, field projection and private journals");
    }
    // All declared cells/payees/limits and the first real input contract are
    // checked BEFORE opening the owner's signer. Source control is not inferred
    // from a buyer's untrusted request or the merchant's unsigned challenge.
    await preflightHttpServiceChain({
      stages: admitted.stages, initialBody: admitted.initialBody,
      network: admitted.network, asset: admitted.asset,
      maximumTotalAtomic: admitted.maximumTotalAtomic,
      validateInput: options.validateInput,
    });
    if (typeof options.openPayer !== "function" && !options.payer) {
      throw new TypeError("Hoare service chain requires an explicit owner-held payer opener");
    }
    const payer = options.payer ?? await options.openPayer(structuredClone(admitted));
    const result = await (options.executeHttpServiceChain ?? executeHttpServiceChain)({
      ...admitted, payer,
      fetchImpl: options.purchaseFetch,
      purchaseHttpResource: options.purchaseHttpResource ?? purchaseHttpResource,
      projectMarketOfferBody: options.projectMarketOfferBody,
      validateInput: options.validateInput,
      validateOutput: options.validateOutput,
      beforePayment: options.beforePayment,
      onSettlement: options.onSettlement,
      onDelivery: options.onDelivery,
      onStage: options.onStage,
      onFailure: options.onFailure,
    });
    return record({
      type: "X402HttpServiceChainResult", provider: ACTOR,
      request: request.id, result,
    });
  }
  if (!admitted || typeof admitted !== "object" || Array.isArray(admitted)
      || typeof admitted.url !== "string" || typeof admitted.network !== "string"
      || typeof admitted.asset !== "string" || typeof admitted.maximumAmount !== "string") {
    throw new TypeError("owner admission must supply the exact resource, network, token and spending ceiling");
  }
  // An admitted quote remains an unsigned pre-payment resource observation.
  // The actor owner supplies bounded egress; no payer or private key is opened.
  if (request.type === "X402HttpQuoteRequest") {
    if (typeof options.quoteFetch !== "function") {
      throw new Error("an x402 quote requires the actor owner's egress-safe quoteFetch");
    }
    const quote = options.readHttpPurchaseQuote ?? readHttpPurchaseQuote;
    const result = await quote({ ...admitted, fetchImpl: options.quoteFetch });
    return record({
      type: "X402HttpQuoteResult", provider: ACTOR,
      request: request.id, result,
    });
  }
  if (request.type === "X402HttpPurchaseRequest" && !options.payer && typeof options.openPayer !== "function") {
    throw new Error("ordinary HTTP purchasing requires the actor owner’s payer or wallet opener");
  }
  if (typeof options.purchaseFetch !== "function") {
    throw new Error("paid x402 purchase requires the actor owner's egress-safe purchaseFetch");
  }
  // Strategy admission precedes signer capability. The owner, never an
  // unsigned merchant challenge, decides who may receive payment.
  requireOwnerPayee(admitted);
  const payer = options.payer ?? (options.openPayer
    ? await options.openPayer(structuredClone(admitted))
    : await (options.openEnterpriseAccountPayer ?? openEnterpriseAccountPayer)(
    options.account ?? {
      deploymentManifestPath: process.env.EVM_DEPLOYMENT_MANIFEST,
      accountBindingPath: process.env.ACCOUNT_BINDING,
      keystorePath: process.env.ACCOUNT_KEYSTORE,
      passwordFile: process.env.ACCOUNT_PASSWORD_FILE,
    },
  ));
  const purchase = request.type === "X402HttpPurchaseRequest"
    ? options.purchaseHttpResource ?? purchaseHttpResource
    : options.purchaseAndAwaitExactResource ?? purchaseAndAwaitExactResource;
  const result = await purchase({
    ...admitted,
    payer, fetchImpl: options.purchaseFetch,
    beforePayment: options.beforePayment,
    onSettlement: options.onSettlement,
    onDelivery: options.onDelivery,
  });
  return record({
    type: request.type === "X402HttpPurchaseRequest" ? "X402HttpPurchaseResult" : "X402ExactPurchaseResult",
    provider: ACTOR,
    request: request.id,
    result,
  });
}

export async function executeA2aMessage(source, options = {}) {
  const message = Message.fromJSON(structuredClone(source));
  if (message.role !== Role.ROLE_USER) throw new Error("x402 purchase executor requires an A2A user Message");
  const input = extractRmnPart(message.parts);
  const response = await executeOperation(decodeSemantic(input.bytes), options);
  const part = rmnPart(semanticBytes(response));
  return Message.toJSON({
    messageId: randomUUID(),
    contextId: message.contextId ?? "",
    taskId: message.taskId ?? "",
    role: Role.ROLE_AGENT,
    parts: [part],
    metadata: { inputNi: input.ni, outputNi: part.metadata.ni, provider: ACTOR },
    extensions: [],
    referenceTaskIds: [],
  });
}
