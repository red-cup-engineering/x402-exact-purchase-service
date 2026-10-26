import assert from "node:assert/strict";
import { test } from "node:test";
import { procureHttpResource } from "../src/procure.mjs";

const ceiling = { network: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", maximumAmount: "50000" };
const response = (status) => ({ ok: status >= 200 && status < 300, status });
// The control-flow fixtures deliberately admit only their own declared free
// successful responses. Real consumers supply their own useful-output law.
const admitFixtureResponse = async ({ source, response }) => source.free === true && response.status === 200;
const quoteFor = (prices) => async ({ url, maximumAmount }) => {
  const amount = prices[url];
  if (amount === undefined || BigInt(amount) > BigInt(maximumAmount)) throw new TypeError("no eligible offer");
  return { requirement: { amount, payTo: "0x" + "22".repeat(20) }, maximumAmount };
};

test("a free source wins without quoting or paying", async () => {
  const rows = [];
  const out = await procureHttpResource({
    candidates: [{ url: "https://paid.example/a", expectedPayTo: "0x" + "22".repeat(20) }, { url: "https://free.example/a", free: true }],
    ceiling, fetchImpl: async () => response(200), record: async (r) => rows.push(r),
    admitFree: admitFixtureResponse,
    readQuote: async () => assert.fail("must not quote"), purchase: async () => assert.fail("must not buy"),
  });
  assert.equal(out.kind, "free");
  assert.equal(rows[0].outcome, "free");
});

test("the cheapest quote under the ceiling is bought; an over-ceiling seller is skipped", async () => {
  const bought = [];
  const rows = [];
  const out = await procureHttpResource({
    candidates: [
      { url: "https://a.example", expectedPayTo: "0x" + "22".repeat(20) },
      { url: "https://b.example", expectedPayTo: "0x" + "22".repeat(20) },
      { url: "https://c.example", expectedPayTo: "0x" + "22".repeat(20) },
    ],
    ceiling, fetchImpl: async () => response(402), record: async (r) => rows.push(r),
    readQuote: quoteFor({ "https://a.example": "30000", "https://b.example": "12000", "https://c.example": "90000" }),
    purchase: async (o) => { bought.push(o.url); return { transaction: "0xabc" }; },
  });
  assert.deepEqual(bought, ["https://b.example"]);
  assert.equal(out.kind, "bought");
  assert.deepEqual({ outcome: rows[0].outcome, amount: rows[0].amount, transaction: rows[0].transaction }, { outcome: "bought", amount: "12000", transaction: "0xabc" });
});

test("an uncharged failure falls through; a charged failure stops so nothing is paid twice", async () => {
  const bought = [];
  const out = await procureHttpResource({
    candidates: [{ url: "https://a.example", expectedPayTo: "0x" + "22".repeat(20) }, { url: "https://b.example", expectedPayTo: "0x" + "22".repeat(20) }],
    ceiling, fetchImpl: async () => response(402),
    readQuote: quoteFor({ "https://a.example": "1000", "https://b.example": "2000" }),
    purchase: async (o) => { bought.push(o.url); if (o.url === "https://a.example") throw new Error("terms drift"); return {}; },
  });
  assert.deepEqual(bought, ["https://a.example", "https://b.example"]);
  assert.equal(out.source.url, "https://b.example");

  const rows = [];
  await assert.rejects(procureHttpResource({
    candidates: [{ url: "https://a.example", expectedPayTo: "0x" + "22".repeat(20) }, { url: "https://b.example", expectedPayTo: "0x" + "22".repeat(20) }],
    ceiling, fetchImpl: async () => response(402), record: async (r) => rows.push(r),
    readQuote: quoteFor({ "https://a.example": "1000", "https://b.example": "2000" }),
    purchase: async () => { const e = new Error("paid but HTTP 500"); e.receipt = { transaction: "0xdead" }; throw e; },
  }), /paid but HTTP 500/);
  assert.deepEqual(rows.map((r) => r.outcome), ["charged-undelivered"]);
});

test("nothing admissible is an error carrying every refusal", async () => {
  await assert.rejects(procureHttpResource({
    candidates: [{ url: "https://c.example", expectedPayTo: "0x" + "22".repeat(20) }],
    ceiling, fetchImpl: async () => response(402), readQuote: quoteFor({ "https://c.example": "90000" }), purchase: async () => ({}),
  }), (e) => e.tried.length === 1 && /no eligible offer/.test(e.tried[0].refused));
});

test("zero cash is a native budget: free delivery without buyer, payee, or paid dependencies", async () => {
  const calls = [], rows = [];
  const out = await procureHttpResource({
    candidates: [
      { url: "https://paid.example/signal", expectedPayTo: "0x" + "22".repeat(20) },
      { url: "https://first-free.example/signal", free: true },
      { url: "https://second-free.example/signal", free: true },
    ],
    ceiling: { maximumAmount: "0" },
    admitFree: admitFixtureResponse,
    fetchImpl: async (url, options) => {
      calls.push([url, options.redirect]);
      if (url.includes("first-free")) throw new Error("free provider unreachable");
      return response(200);
    },
    record: async row => rows.push(row),
    readQuote: async () => assert.fail("a zero-cash turn must never quote paid sources"),
    purchase: async () => assert.fail("a zero-cash turn must never purchase"),
  });
  assert.equal(out.kind, "free");
  assert.equal(out.source.url, "https://second-free.example/signal");
  assert.deepEqual(calls, [["https://first-free.example/signal", "manual"], ["https://second-free.example/signal", "manual"]]);
  assert.equal(rows.length, 1);
  assert.deepEqual({ amount: rows[0].amount, outcome: rows[0].outcome }, { amount: "0", outcome: "free" });
});

test("zero cash excludes paid fallback and quotes even after a declared free source returns 402", async () => {
  const rows = [], calls = [];
  await assert.rejects(procureHttpResource({
    candidates: [
      { url: "https://free.example/signal", free: true },
      { url: "https://paid.example/signal", expectedPayTo: "0x" + "22".repeat(20) },
    ],
    ceiling: { maximumAmount: "0" },
    admitFree: admitFixtureResponse,
    fetchImpl: async url => { calls.push(url); return response(402); },
    record: async row => rows.push(row),
    readQuote: async () => assert.fail("zero-cash procurement cannot inspect paid sources"),
    purchase: async () => assert.fail("zero-cash procurement cannot sign a purchase"),
  }), error => error.code === "ZERO_CASH_PROCUREMENT_EXHAUSTED"
      && error.tried.length === 1 && error.tried[0].status === 402);
  assert.deepEqual(calls, ["https://free.example/signal"]);
  assert.deepEqual(rows.map(row => row.outcome), ["unprocured"]);
  assert.equal(rows[0].reason, "zero-cash-ceiling");
});

test("positive budgets preserve the admitted paid-price ranking after free attempts fail", async () => {
  const bought = [];
  const out = await procureHttpResource({
    candidates: [
      { url: "https://free.example", free: true },
      { url: "https://expensive.example", expectedPayTo: "0x" + "22".repeat(20) },
      { url: "https://cheap.example", expectedPayTo: "0x" + "22".repeat(20) },
    ],
    ceiling, fetchImpl: async () => response(503),
    admitFree: admitFixtureResponse,
    readQuote: quoteFor({ "https://expensive.example": "3000", "https://cheap.example": "2000" }),
    purchase: async ({ url }) => { bought.push(url); return { transaction: "0xabc" }; },
  });
  assert.equal(out.kind, "bought");
  assert.deepEqual(bought, ["https://cheap.example"]);
});

test("non-string zero is refused before egress; failed receipt recording is never treated as a failed supplier", async () => {
  let calls = 0;
  await assert.rejects(procureHttpResource({
    candidates: [{ url: "https://free.example", free: true }],
    ceiling: { maximumAmount: 0 },
    fetchImpl: async () => { calls++; return response(200); },
  }), /nonnegative integer atomic/);
  assert.equal(calls, 0);
  await assert.rejects(procureHttpResource({
    candidates: [
      { url: "https://first.example", free: true },
      { url: "https://second.example", free: true },
    ],
    ceiling: { maximumAmount: "0" },
    admitFree: admitFixtureResponse,
    fetchImpl: async () => { calls++; return response(200); },
    record: async () => { throw new Error("ledger unavailable"); },
  }), /ledger unavailable/);
  assert.equal(calls, 1);
});

test("a zero-cash buyer refuses HTTP 200 without source-quality admission and uses the next free supplier", async () => {
  const calls = [], rows = [];
  const result = await procureHttpResource({
    candidates: [
      { url: "https://stale.example/data", free: true },
      { url: "https://fresh.example/data", free: true },
      { url: "https://paid.example/data", expectedPayTo: "0x" + "22".repeat(20) },
    ],
    ceiling: { maximumAmount: "0" },
    fetchImpl: async url => { calls.push(url); return response(200); },
    admitFree: async ({ source }) => source.url === "https://fresh.example/data",
    record: async row => rows.push(row),
    readQuote: async () => assert.fail("no paid fallback"),
    purchase: async () => assert.fail("no signing"),
  });
  assert.equal(result.kind, "free");
  assert.equal(result.source.url, "https://fresh.example/data");
  assert.deepEqual(calls, ["https://stale.example/data", "https://fresh.example/data"]);
  assert.equal(rows[0].amount, "0");
});

test("a malformed free-source acceptance predicate cannot authorize a purchase", async () => {
  const calls = [];
  await assert.rejects(procureHttpResource({
    candidates: [
      { url: "https://bad.example", free: true },
      { url: "https://paid.example", expectedPayTo: "0x" + "22".repeat(20) },
    ],
    ceiling: { maximumAmount: "0" },
    fetchImpl: async url => { calls.push(url); return response(200); },
    admitFree: async () => { throw new Error("untrusted source is malformed"); },
    readQuote: async () => assert.fail("paid quote prohibited"),
    purchase: async () => assert.fail("paid purchase prohibited"),
  }), e => e.code === "ZERO_CASH_PROCUREMENT_EXHAUSTED"
    && e.tried[0]?.refused === "free-output-admission-error");
  assert.deepEqual(calls, ["https://bad.example"]);
});

test("free candidates require the consumer's admission contract before any effect", async () => {
  for (const maximumAmount of ["0", "50000"]) {
    for (const admitFree of [undefined, null, true, "accept"]) {
      const effects = [];
      await assert.rejects(procureHttpResource({
        candidates: [
          { url: "https://free.example/data", free: true },
          { url: "https://paid.example/data", expectedPayTo: "0x" + "22".repeat(20) },
        ],
        ceiling: { ...ceiling, maximumAmount },
        ...(admitFree === undefined ? {} : { admitFree }),
        fetchImpl: async () => { effects.push("fetch"); return response(200); },
        record: async () => { effects.push("record"); },
        readQuote: async () => { effects.push("quote"); return {}; },
        purchase: async () => { effects.push("purchase"); return {}; },
      }), /admitFree must be a source-qualified response acceptance function/);
      assert.deepEqual(effects, [], "missing source acceptance must not become free delivery or paid fallback");
    }
  }
});

test("consumer admission can read and qualify the body without consuming delivered bytes", async () => {
  const expected = { edition: "fixture.v1", value: 42 };
  const result = await procureHttpResource({
    candidates: [
      { url: "https://free.example/wrong-edition", free: true },
      { url: "https://free.example/accepted", free: true },
    ],
    ceiling: { maximumAmount: "0" },
    fetchImpl: async url => Response.json(url.endsWith("/accepted")
      ? expected : { edition: "fixture.v0", value: 42 }),
    admitFree: async ({ source, response }) => {
      const value = await response.json();
      return source.url === "https://free.example/accepted"
        && value.edition === expected.edition && value.value === expected.value;
    },
    readQuote: async () => assert.fail("zero-cash receiving cannot quote"),
    purchase: async () => assert.fail("zero-cash receiving cannot purchase"),
  });
  assert.equal(result.kind, "free");
  assert.equal(result.source.url, "https://free.example/accepted");
  assert.deepEqual(await result.response.json(), expected);
});

test("a received purchase is not repeated when its outcome cannot be recorded", async () => {
  for (const deliveryFailed of [false, true]) {
    const bought = [], rows = [];
    const receipt = { transaction: "0xretained-first-purchase" };
    const ledgerError = new Error("ledger unavailable");
    const deliveryError = Object.assign(new Error("paid delivery unavailable"), { receipt });
    await assert.rejects(procureHttpResource({
      candidates: [
        { url: "https://first.example/data", expectedPayTo: "0x" + "22".repeat(20) },
        { url: "https://second.example/data", expectedPayTo: "0x" + "22".repeat(20) },
      ],
      ceiling,
      fetchImpl: async () => assert.fail("the bounded quote fixture owns discovery"),
      readQuote: quoteFor({ "https://first.example/data": "1000", "https://second.example/data": "2000" }),
      purchase: async ({ url }) => {
        bought.push(url);
        if (deliveryFailed) throw deliveryError;
        return receipt;
      },
      record: async row => { rows.push(row); throw ledgerError; },
    }), error => error.code === "PROCUREMENT_RECORD_FAILED"
      && error.receipt === receipt && error.cause === ledgerError
      && (deliveryFailed ? error.purchaseError === deliveryError : !error.purchaseError));
    assert.deepEqual(bought, ["https://first.example/data"],
      "bookkeeping failure cannot purchase the same need from a second supplier");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, deliveryFailed ? "charged-undelivered" : "bought");
    assert.equal(rows[0].transaction, receipt.transaction);
  }
});
