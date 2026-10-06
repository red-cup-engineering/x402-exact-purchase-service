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

export async function executeOperation(request, options = {}) {
  if (!exact(request) || request.provider !== ACTOR) {
    throw new Error("exact provider-addressed canonical SEN operation is required");
  }
  if (!["X402ExactPurchaseRequest", "X402HttpPurchaseRequest"].includes(request.type) || !request.purchase || typeof request.purchase !== "object") {
    throw new Error("x402 exact purchase request requires one purchase");
  }
  const payer = options.payer ?? await (options.openEnterpriseAccountPayer ?? openEnterpriseAccountPayer)(
    options.account ?? {
      deploymentManifestPath: process.env.EVM_DEPLOYMENT_MANIFEST,
      accountBindingPath: process.env.ACCOUNT_BINDING,
      keystorePath: process.env.ACCOUNT_KEYSTORE,
      passwordFile: process.env.ACCOUNT_PASSWORD_FILE,
    },
  );
  const purchase = request.type === "X402HttpPurchaseRequest"
    ? options.purchaseHttpResource ?? purchaseHttpResource
    : options.purchaseAndAwaitExactResource ?? purchaseAndAwaitExactResource;
  const result = await purchase({
    ...request.purchase,
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
  const message = Message.fromJSON(source);
  if (message.role !== Role.ROLE_USER) throw new Error("x402 purchase executor requires an A2A user Message");
  const input = extractRmnPart(message.parts);
  const response = await executeOperation(decodeSemantic(input.bytes), options);
  return Message.toJSON({
    messageId: "",
    contextId: message.contextId ?? "",
    taskId: message.taskId ?? "",
    role: Role.ROLE_AGENT,
    parts: [rmnPart(semanticBytes(response))],
    metadata: { inputNi: input.ni, outputNi: response.id, provider: ACTOR },
    extensions: [],
    referenceTaskIds: [],
  });
}
