import { readFileSync } from "node:fs";
import { compileRmlLaw } from "@red-cup-engineering/rmn-semantic-conformance/law";

export const X402_EXACT_PURCHASE_LAW = compileRmlLaw(
  readFileSync(new URL("../content/contracts/purchase-x402-exact-resource.rml", import.meta.url), "utf8"),
);
