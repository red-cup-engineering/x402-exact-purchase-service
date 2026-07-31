#!/usr/bin/env node

import { spawn } from "node:child_process";
import { loadSuccessorAccountBinding } from "../src/successor-deployment.mjs";

const active = await loadSuccessorAccountBinding({
  manifestPath: process.env.EVM_DEPLOYMENT_MANIFEST,
  accountBindingPath: process.env.ACCOUNT_BINDING,
  nodeId: "x402-exact-purchase-service",
});
const child = spawn(
  process.execPath,
  ["node_modules/@red-cup-engineering/activitypub-services-section/src/server.mjs"],
  {
    env: {
      ...process.env,
      ACTIVITYPUB_CONTROLLER: `did:pkh:${active.account}`,
    },
    stdio: "inherit",
  },
);
child.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
