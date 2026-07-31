import { readFile } from "node:fs/promises";

const CAIP2 = "eip155:5615611";
const ADDRESS = /^0x[0-9a-f]{40}$/u;

export class SuccessorChainMigrationObstruction extends Error {
  constructor(requirement, {
    nodeId,
    cause,
    code = "SUCCESSOR_CHAIN_IDENTITY_UNBOUND",
  } = {}) {
    super(requirement, { cause });
    this.name = "SuccessorChainMigrationObstruction";
    this.code = code;
    this.type = "SuccessorChainMigrationObstruction";
    this.chain = CAIP2;
    this.nodeId = nodeId;
    this.requirement = requirement;
  }
}

export function requireActiveSuccessorRecord(record, expectedType, nodeId) {
  if (record?.type === "SuccessorChainMigrationObstruction") {
    throw new SuccessorChainMigrationObstruction(record.requirement, { nodeId });
  }
  if (record?.kind !== expectedType && record?.type !== expectedType) {
    throw new SuccessorChainMigrationObstruction(
      `regenerate the active ${expectedType} for ${nodeId} from its verified eip155:5615611 identity and economic bindings`,
      { nodeId },
    );
  }
  return record;
}

async function json(path, label, nodeId) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new SuccessorChainMigrationObstruction(
      `${label} is absent or unreadable; provision it through the canonical enterprise-account/deployment owner before enabling this service`,
      { nodeId, cause },
    );
  }
}

export async function loadSuccessorDeployment(manifestPath) {
  if (!((typeof manifestPath === "string" && manifestPath.trim() !== "")
      || manifestPath instanceof URL)) {
    throw new SuccessorChainMigrationObstruction(
      "EVM_DEPLOYMENT_MANIFEST must name the canonical eip155:5615611 deployment manifest",
    );
  }
  const manifest = await json(manifestPath, "canonical eip155:5615611 deployment manifest");
  const exchange = manifest.deployments?.find(
    (entry) => entry?.role === "modeled-union-dimension-exchange"
      && entry?.standard === "org.emsenn.semiotic-exchange-chain.v1",
  );
  const address = exchange?.address?.toLowerCase();
  if (manifest.chainId !== CAIP2 || !ADDRESS.test(address ?? "")
      || !Number.isSafeInteger(exchange?.blockNumber) || exchange.blockNumber < 0) {
    throw new SuccessorChainMigrationObstruction(
      "deployment manifest must bind eip155:5615611 to one exact deployed SemioticExchange",
    );
  }
  return Object.freeze({
    chain: CAIP2,
    exchange: address,
    deploymentBlock: exchange.blockNumber,
    transactionHash: exchange.transactionHash,
    rpc: manifest.rpc,
    manifestPath,
  });
}

export async function loadSuccessorAccountBinding({
  manifestPath,
  accountBindingPath,
  nodeId,
} = {}) {
  const deployment = await loadSuccessorDeployment(manifestPath);
  if (typeof accountBindingPath !== "string" || accountBindingPath.trim() === "") {
    throw new SuccessorChainMigrationObstruction(
      `SETTLEMENT_ACCOUNT_BINDING must name a verified ${CAIP2} enterprise-account binding for ${nodeId}; no predecessor account may be reused`,
      { nodeId },
    );
  }
  const binding = await json(
    accountBindingPath,
    `verified ${CAIP2} enterprise-account binding for ${nodeId}`,
    nodeId,
  );
  const address = binding?.account?.address?.toLowerCase();
  if (binding?.profile !== "org.emsenn.evm.sovereign-enterprise-account.v3"
      || binding?.enterprise?.nodeId !== nodeId
      || binding?.chain?.caip2 !== deployment.chain
      || binding?.account?.caip10?.toLowerCase() !== `${deployment.chain}:${address}`
      || !ADDRESS.test(address ?? "")
      || !/^0x[0-9a-f]{64}$/u.test(binding?.deployment?.transaction?.toLowerCase() ?? "")
      || !Number.isSafeInteger(binding?.deployment?.block)) {
    throw new SuccessorChainMigrationObstruction(
      `provision and verify one ${CAIP2} EnterpriseAccount for ${nodeId}, then regenerate its account binding, Agent Card, capability identity, and offers`,
      { nodeId },
    );
  }
  return Object.freeze({
    deployment,
    binding,
    account: binding.account.caip10.toLowerCase(),
    address,
  });
}

export async function loadSuccessorX402Binding({
  path,
  deployment,
  account,
  nodeId,
} = {}) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new SuccessorChainMigrationObstruction(
      `X402_BINDING must name a verified ${CAIP2} facilitator, asset, and payee binding for ${nodeId}`,
      { nodeId, code: "SUCCESSOR_X402_BINDING_UNBOUND" },
    );
  }
  const binding = await json(path, `verified ${CAIP2} x402 economic binding for ${nodeId}`, nodeId);
  const payee = account?.split(":").at(-1)?.toLowerCase();
  if (binding?.type !== "SuccessorX402Binding"
      || binding?.network !== deployment?.chain
      || binding?.exchange?.toLowerCase() !== deployment?.exchange
      || !ADDRESS.test(binding?.asset?.toLowerCase() ?? "")
      || binding?.payTo?.toLowerCase() !== payee
      || !/^https:\/\//u.test(binding?.facilitatorUrl ?? "")
      || typeof binding?.assetName !== "string" || binding.assetName.trim() === ""
      || typeof binding?.assetVersion !== "string" || binding.assetVersion.trim() === "") {
    throw new SuccessorChainMigrationObstruction(
      `verify and record the ${CAIP2} x402 facilitator, asset contract, exact enterprise-account payee, and asset metadata for ${nodeId}`,
      { nodeId, code: "SUCCESSOR_X402_BINDING_UNBOUND" },
    );
  }
  return Object.freeze({
    ...binding,
    asset: binding.asset.toLowerCase(),
    payTo: binding.payTo.toLowerCase(),
  });
}
