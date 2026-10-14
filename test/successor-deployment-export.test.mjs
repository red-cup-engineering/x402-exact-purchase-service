import assert from "node:assert/strict";
import test from "node:test";
import * as canonical from "../src/successor-deployment.mjs";
import * as publicOwner from "@red-cup-engineering/x402-exact-purchase-service/successor-deployment";

test("the standalone owner exports the existing one successor deployment admission surface", () => {
  const expected = [
    "SuccessorChainMigrationObstruction",
    "loadSuccessorAccountBinding",
    "loadSuccessorDeployment",
    "loadSuccessorX402Binding",
    "requireActiveSuccessorRecord",
  ];
  assert.deepEqual(Object.keys(publicOwner).sort(), expected.sort());
  for(const name of expected) assert.equal(publicOwner[name], canonical[name],
    "public package subpath must resolve to the same implementation: " + name);
  assert.ok(publicOwner.SuccessorChainMigrationObstruction.prototype instanceof Error);
});
