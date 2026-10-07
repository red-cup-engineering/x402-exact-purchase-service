import { randomUUID } from "node:crypto";
import { Message, Role } from "@a2a-js/sdk";
import { extractRmnPart, rmnPart } from "@red-cup-engineering/a2a-rmn-part-service";
import { decodeSemantic, semanticBytes, semanticId } from "@red-cup-engineering/relation-model-notation-runtime";
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
  if (!["X402ExactPurchaseRequest", "X402HttpPurchaseRequest"].includes(request.type) || !request.purchase || typeof request.purchase !== "object") {
    throw new Error("x402 exact purchase request requires one purchase");
  }
  if (typeof options.admitPurchase !== "function") {
    throw new Error("the actor owner must admit the purchase before its wallet is opened");
  }
  const admitted = structuredClone(await options.admitPurchase(structuredClone(request)));
  if (!admitted || typeof admitted !== "object" || Array.isArray(admitted)
      || typeof admitted.url !== "string" || typeof admitted.network !== "string"
      || typeof admitted.asset !== "string" || typeof admitted.maximumAmount !== "string") {
    throw new TypeError("owner admission must supply the exact resource, network, token and spending ceiling");
  }
  if (request.type === "X402HttpPurchaseRequest" && !options.payer && typeof options.openPayer !== "function") {
    throw new Error("ordinary HTTP purchasing requires the actor owner’s payer or wallet opener");
  }
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
    payer,
    beforePayment: options.beforePayment,
    onSettlement: options.onSettlement,
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
