import { rawNiUri } from "@red-cup-engineering/rmn-semantic-conformance-die/canonical-cbor";

const CHAIN = "eip155:5615611";
const NODE = "x402-exact-purchase-service";
const URN = `urn:ame:${NODE}`;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HASH = /^0x[0-9a-fA-F]{64}$/u;
const NI = /^ni:\/\/\/sha-256;[A-Za-z0-9_-]{43}$/u;
const SKU = "ni:///sha-256;pMiMtvHEynQ4UYRhKSt4tgoLgtV8pXNheV7PgTLzDbY";
const LAW = "ni:///sha-256;NNhMz_THxHvEi5V_7dwduZteH46tzyOtDqBctYsmib8";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function contentAddress(value) {
  return rawNiUri(JSON.stringify(stable(value)));
}

function exactDeployment(deployment) {
  const entryPoint = deployment?.deployments?.filter((item) => item?.standard === "org.ethereum.erc-4337.entry-point.v0.8" && item?.role === "account-abstraction-entry-point") ?? [];
  const exchange = deployment?.deployments?.filter((item) => item?.standard === "org.emsenn.semiotic-exchange-chain.v1" && item?.role === "modeled-union-dimension-exchange") ?? [];
  const factory = deployment?.deployments?.filter((item) => item?.standard === "org.emsenn.evm.sovereign-enterprise-account.v3" && item?.role === "sovereign-settlement-account-factory") ?? [];
  if (deployment?.profile !== "org.emsenn.evm.standards-deployment.v2" || deployment?.type !== "UnionEvmStandardsDeployment"
      || deployment?.chainId !== CHAIN || !/^[0-9a-f]{64}$/u.test(deployment?.genesisSha256 ?? "")
      || entryPoint.length !== 1 || exchange.length !== 1 || factory.length !== 1
      || !ADDRESS.test(entryPoint[0].address ?? "") || !ADDRESS.test(exchange[0].address ?? "")
      || !ADDRESS.test(factory[0].address ?? "") || !HASH.test(exchange[0].transactionHash ?? "")
      || !Number.isSafeInteger(exchange[0].blockNumber)) {
    throw new TypeError("one verified canonical eip155:5615611 SuccessorDeployment is required");
  }
  return Object.freeze({ chain: CHAIN, genesisSha256: deployment.genesisSha256,
    entryPoint: entryPoint[0].address.toLowerCase(),
    exchange: exchange[0].address.toLowerCase(), deploymentBlock: exchange[0].blockNumber,
    deploymentTransaction: exchange[0].transactionHash.toLowerCase(), factory: factory[0].address.toLowerCase() });
}

function exactAccount(binding, deployment) {
  const account = binding?.account?.address?.toLowerCase();
  const localPolicy = binding?.policy?.custody === "settlement-private"
    && Object.keys(binding.policy).sort().join() === ["custody", "signer"].sort().join();
  const cloudPolicy = binding?.policy?.custody === "remote-cloud-kms-hsm"
    && /^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+\/cryptoKeyVersions\/[^/]+$/u.test(binding?.policy?.keyVersion ?? "");
  if (binding?.profile !== "org.emsenn.evm.sovereign-enterprise-account.v3"
      || binding?.enterprise?.nodeId !== NODE || binding?.enterprise?.urn !== URN
      || !HASH.test(binding?.enterprise?.enterpriseId ?? "") || binding?.chain?.chainId !== 5615611
      || binding?.chain?.caip2 !== CHAIN || !ADDRESS.test(account ?? "")
      || binding?.account?.caip10?.toLowerCase() !== `${CHAIN}:${account}`
      || binding?.factory?.address?.toLowerCase() !== deployment.factory || !HASH.test(binding?.factory?.userSalt ?? "")
      || (!localPolicy && !cloudPolicy) || !ADDRESS.test(binding?.policy?.signer ?? "")
      || !HASH.test(binding?.deployment?.transaction ?? "")
      || !Number.isSafeInteger(binding?.deployment?.block)) {
    throw new TypeError(`one verified EnterpriseAccountBinding for ${NODE} on ${CHAIN} is required`);
  }
  return Object.freeze({ address: account, caip10: `${CHAIN}:${account}`, controller: `did:pkh:${CHAIN}:${account}` });
}

function exactEconomic(binding, deployment, account) {
  if (binding?.type !== "SuccessorX402Binding" || binding?.network !== CHAIN
      || binding?.exchange?.toLowerCase() !== deployment.exchange || !ADDRESS.test(binding?.asset ?? "")
      || binding?.payTo?.toLowerCase() !== account.address || !/^https:\/\/[^\s]+$/u.test(binding?.facilitatorUrl ?? "")
      || typeof binding?.assetName !== "string" || binding.assetName.trim() === ""
      || typeof binding?.assetVersion !== "string" || binding.assetVersion.trim() === ""
      || !/^[1-9][0-9]*$/u.test(binding?.amount ?? "")) {
    throw new TypeError(`one verified SuccessorX402Binding for ${NODE} on ${CHAIN} is required`);
  }
  return Object.freeze({ network: CHAIN, exchange: deployment.exchange, asset: binding.asset.toLowerCase(),
    payTo: account.address, facilitatorUrl: binding.facilitatorUrl, assetName: binding.assetName,
    assetVersion: binding.assetVersion, amount: binding.amount });
}

function attachedSignature(receipt, payload, controller) {
  if (receipt === undefined) return Object.freeze({ status: "unsigned-candidate", payload, receipts: [] });
  const signature = receipt?.signature;
  const signaturePresent = typeof signature === "string" ? signature !== ""
    : signature !== null && typeof signature === "object" && !Array.isArray(signature)
      && typeof signature.protected === "string" && signature.protected !== ""
      && typeof signature.signature === "string" && signature.signature !== "";
  if (receipt?.type !== "DetachedContentSigningReceipt" || receipt?.version !== 1 || receipt?.disposition !== "signed"
      || receipt?.payload !== payload || receipt?.controller?.toLowerCase() !== controller.toLowerCase()
      || receipt?.verification?.disposition !== "verified"
      || !NI.test(receipt?.id ?? "") || typeof receipt?.algorithm !== "string" || receipt.algorithm === ""
      || typeof receipt?.keyId !== "string" || receipt.keyId === "" || !signaturePresent) {
    throw new TypeError("signing receipt must be a real detached receipt for this exact payload and controller");
  }
  return Object.freeze({ status: "signed", payload, receipts: [structuredClone(receipt)] });
}

export function projectX402SuccessorActivation({ deployment, accountBinding, x402Binding, agentCardTemplate, offerSigningReceipt } = {}) {
  const successor = exactDeployment(deployment);
  const account = exactAccount(accountBinding, successor);
  const economic = exactEconomic(x402Binding, successor, account);
  if (agentCardTemplate === null || typeof agentCardTemplate !== "object" || Array.isArray(agentCardTemplate)) throw new TypeError("the package-owned Agent Card template is required");
  const identityPayload = { type: "CapabilityCellIdentity", version: 2, sku: SKU, capability: LAW,
    controller: account.controller, settlementDeployment: successor, x402: economic };
  const identity = Object.freeze({ id: contentAddress(identityPayload), ...identityPayload });
  const manifestPayload = { type: "CapabilityCellManifest", version: 3, cell: identity.id, sku: SKU,
    capability: LAW, controller: account.controller, faces: {
      github: { repository: "https://github.com/red-cup-engineering/x402-exact-purchase-service",
        identity: "https://raw.githubusercontent.com/red-cup-engineering/x402-exact-purchase-service/main/content/capcell/identity.json" },
      activitypub: { actor: "https://bare-cedar-fog.561.group/actors/x402-exact-purchase" },
      a2a: { agentCard: "https://bare-cedar-fog.561.group/a2a/x402-exact-purchase/.well-known/agent-card.json" },
      x402: { offer: "https://bare-cedar-fog.561.group/x402/x402-exact-purchase/offer",
        invoke: "https://bare-cedar-fog.561.group/x402/x402-exact-purchase/invoke", scheme: "exact", ...economic },
      evm: { network: CHAIN, account: account.caip10, exchange: successor.exchange },
    } };
  const manifest = Object.freeze({ id: contentAddress(manifestPayload), ...manifestPayload });
  const offerPayload = { kind: "org.emsenn.capability-offer.v3", cell: identity.id, sku: SKU, provider: URN,
    operation: "purchase-x402-exact-resource", law: LAW,
    agentCard: "https://bare-cedar-fog.561.group/a2a/x402-exact-purchase/.well-known/agent-card.json",
    authorization: { profile: "OCapN", grantRequired: true }, price: { protocol: "x402", scheme: "exact",
      network: CHAIN, asset: economic.asset, amount: economic.amount, payTo: economic.payTo,
      facilitator: economic.facilitatorUrl, extra: { name: economic.assetName, version: economic.assetVersion } } };
  const offerId = contentAddress(offerPayload);
  const offer = Object.freeze({ id: offerId, ...offerPayload, signing: attachedSignature(offerSigningReceipt, offerId, account.controller) });
  const card = structuredClone(agentCardTemplate);
  card.description = card.description.replace(" Active settlement is unavailable until the recorded eip155:5615611 identity migration is completed.", "");
  for (const extension of card.capabilities?.extensions ?? []) {
    delete extension.params?.availability;
    extension.params = { ...extension.params, cell: identity.id, controller: account.controller,
      account: account.caip10, settlementDeployment: successor, x402: economic };
  }
  delete card.activation;
  card.signatures = [];
  card.activation = { profile: "org.emsenn.successor-activation.v1", identity: identity.id,
    manifest: manifest.id, offer: offer.id,
    signing: { status: "runtime-signature-required", receipts: [] } };
  const residualBase = { version: 1, chain: CHAIN, controller: account.controller, identity: identity.id,
    manifest: manifest.id, offer: offer.id };
  const invocation = { type: "CapabilityInvocationStateResidual", ...residualBase, state: "idle",
    activeInvocation: null, terminalReceipt: null };
  invocation.id = contentAddress(invocation);
  const health = { type: "SuccessorActivationHealthResidual", ...residualBase,
    state: "configured-not-live-observed", chainObserved: false, facilitatorObserved: false,
    assetObserved: false, signatureStatus: offer.signing.status, networkCallsMadeByProjector: 0 };
  health.id = contentAddress(health);
  const activation = { type: "SuccessorChainActivationProjection", version: 1, state: "configured",
    nodeId: NODE, deployment: successor, account: account.caip10, identity: identity.id,
    manifest: manifest.id, offer: offer.id, health: health.id };
  activation.id = contentAddress(activation);
  const activityObject = { type: "SuccessorCapabilityActivation", nodeId: NODE, chain: CHAIN,
    controller: account.controller, identity: identity.id, manifest: manifest.id, offer: offer.id,
    health: health.id, liveObservationClaimed: false };
  const outbox = [{ "@context": "https://www.w3.org/ns/activitystreams",
    id: `https://bare-cedar-fog.561.group/activities/x402-exact-purchase/activation/${contentAddress(activityObject).slice("ni:///sha-256;".length)}`,
    type: "Announce", actor: "https://bare-cedar-fog.561.group/actors/x402-exact-purchase",
    to: "https://www.w3.org/ns/activitystreams#Public", object: activityObject }];
  const outputs = { "content/agent-cards/x402-exact-purchase.json": card,
    "content/capcell/identity.json": identity, "content/capcell/manifest.json": manifest,
    "content/capcell/customer-invocation.json": invocation, "content/offers/current.json": offer,
    "content/health/current.json": health, "content/activitypub/outbox.json": outbox,
    "content/migrations/eip155-5615611.json": activation };
  if (JSON.stringify(outputs).includes("5615610")) throw new Error("successor activation leaked a predecessor identity or economic term");
  return Object.freeze({ type: "SuccessorActivationProjection", version: 1, id: contentAddress(outputs),
    nodeId: NODE, outputs: Object.freeze(outputs) });
}
