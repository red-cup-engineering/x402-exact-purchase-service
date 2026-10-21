# Native HTTP purchasing

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

**Canonical package ownership:** this standalone repository is the intended Red Cup source owner for `@red-cup-engineering/x402-exact-purchase-service`. Its embedded same-name predecessor still exists inside `computer-engineering-services-section`; that is a migration source, **not** a second merchant, wallet, or independent buyer authority. Their successor-deployment source blobs coincide, and the standalone package now exports the existing `./successor-deployment` subpath. Their A2A transport, policy-signer custody and activation materialization still differ; removing or rebinding the predecessor requires exact dependency closure and downstream receiving, not blind file deletion. Neither source claims that consolidation or live chain receiving has already occurred.

`purchaseHttpResource` buys an HTTPS representation using the official x402 SDK. The owner supplies the signer, CAIP-10 account, network, token and maximum amount, and an explicit egress-safe `fetchImpl` to send the unsigned probe and paid request. No default ambient `globalThis.fetch` can send a signed authorization to an unadmitted endpoint. For **every paid request**, the owner supplies an **independently authorized** `expectedPayTo` before any network probe or signing. Unknown payees may be observed with the **unsigned quote API only**; a seller-authored 402 challenge must never select its own recipient as the buyer's spending authority. A challenge naming a different recipient is refused before signing. Optional recipient, asset or payer fields in a facilitator report cannot contradict those admitted terms; a report is still not independent chain settlement proof. `beforePayment` receives the exact request and signed payment before transmission; `onSettlement` receives the facilitator’s report before delivery is read. Retain both in the purchasing enterprise’s own books. A settlement report, received bytes and requester acceptance are distinct observations.

## Budgeted x402 quotes, before wallet custody

The Engineering buyer now exports `@red-cup-engineering/x402-exact-purchase-service/http-quote`:

```js
import { readHttpPurchaseQuote } from "@red-cup-engineering/x402-exact-purchase-service/http-quote";

const quote = await readHttpPurchaseQuote({
  url: "https://merchant.example/compute",
  method: "POST",
  body: { size: 3 },
  network: "eip155:8453",
  asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  maximumAmount: "10000", // atomic units, not a floating-point dollar amount
  expectedPayTo: "0x2222222222222222222222222222222222222222",
  fetchImpl: enterpriseEgressSafeFetch, // supplied by the operator
});
// Inspect quote.requirement and quote.request; no payer or signer is opened.
```

`readHttpPurchaseQuote` sends exactly **one unsigned HTTP probe** and admits only the official x402 v2 payment requirement for the exact resource, selected network, token, bounded price and independently authorized recipient. The caller supplies an egress-controlled `fetchImpl`; it does not use ambient network authority or follow redirects. POST and other state-changing method probes are for already-known **payment-first** sellers only; an untrusted non-x402 origin might otherwise perform a side effect before returning 402. This is not an automatic purchase. The readout explicitly reports that no signing, payment, settlement, or delivery has occurred.

To **form a durable exact-EVM signature**, import
`authorizeQuotedHttpPayment` from
`@red-cup-engineering/x402-exact-purchase-service/http-authorization`.
It consumes one owner's `{quote, paymentRequired}`, exact URL/method/body and
owner-held `payer` ({signer, network, caip10}), asset, budget and **independently
authorized payee**. It refuses resource, representation or full-term drift
before signing, then returns a replayable PAYMENT-SIGNATURE with explicit
no-payment/no-settlement observations. Never log or expose that signature:
the buyer must durably retain it in a private original recovery record before
sending. The same `exactEvmBuyerClient` now configures ordinary and
recoverable purchases, rather than each public storefront registering its
own x402 signing protocol.

For owners of **durably recoverable purchases**, the same subpath now also exports
`readHttpPurchaseTerms(options)`. It performs the identical bounded unsigned
402 read but returns `{quote, paymentRequired}`: the quote is the owner's
unspent choice and the second field is the fully schema-admitted original
x402 v2 challenge needed by the official EVM client to form a signature.
It never returns a wallet, signature or accepted delivery. A recoverable
buyer can persist its own signed authorization **before** any paid HTTP send,
then replay the exact signature under its recovery protocol; the application
must keep custody of that sensitive record and independently accept the
recipient, spend ceiling, storage and retrial budget. Both quote forms
share one parsed protocol admission, resource identity and exact offer
selector. A raw third-party 402 cannot independently authorize a purchase.

The pure `selectExactPaymentRequirement` is shared with `purchaseHttpResource`, so inspections and executed purchases **cannot silently diverge** on which offers are eligible. A matching unsigned offer is not a commitment from the seller, a proof of current market price, or an independent payment/chain receipt. An enterprise can now pass its **owner-admitted** `acceptedQuote` from `readHttpPurchaseQuote` into `purchaseHttpResource`. The one upstream request preparer binds URL, HTTP method, normalized caller-header digest and serialized body digest; before signing, the purchase additionally requires the new 402 to preserve the entire accepted payment requirement (including exact amount, recipient, timeout and token-signing metadata). Request drift is refused before egress; terms drift is refused before a signature, with `X402_QUOTE_DRIFT`. This reduces quote-to-purchase substitution risk but the unsigned quote remains **neither independent merchant authority nor proof of settlement**. Only the enterprise owner's admission can authorize buying, and the owner still supplies its own egress policy and payment-recipient authority.

Operators must re-admit the observed quote during the actual purchase. For broader public, unsigned **GET/HEAD** discovery and Bazaar metadata inspection, the separate `@561-group/x402-boundary-reference/observe` already exists; this API specializes the Engineering buyer to a particular enterprise budget and exact method/body rather than recreating that public catalog product.

For an A2A purchase proposal, run:

```sh
execute-x402-exact-purchase-a2a-message --owner-module /absolute/path/owner.mjs < proposal.json
```

For a **purchase**, the operator-controlled module exports `admitPurchase(proposal)`, `openPayer(admittedPurchase)`, and `purchaseFetch(url, init)`: the last is an independently admitted egress capability for both signing-phase HTTP requests and subsequent private-exchange result reads. For an unsigned **A2A quote**, send an addressed `X402HttpQuoteRequest` with the same `purchase` proposal; its owner module exports `admitPurchase(proposal)` and `quoteFetch(url, init)` instead. The quote command opens no payer, uses the owner-controlled fetch capability, and returns an addressed `X402HttpQuoteResult` with the exact request, admitted requirement, and explicit no-payment observations. The owner may expose both quote and purchase capabilities in one module. The direct `purchase-x402-exact-resource` and the paid x402 seller also require the same `purchaseFetch` export of their respective owner modules. Caller-supplied URLs alone must not confer ambient network access. The seller's owner must allowlist its configured `PRICE_QUOTE_URL` as well as the exact downstream invoke, offer and recovery-result endpoints; the pricing-provider POST now also travels through the same explicit `purchaseFetch`, with redirects refused. Admission returns the exact URL, network, asset and maximumAmount the owner permits, plus any permitted method, headers and body. Refuse by throwing. The caller’s proposed spending ceiling is not wallet authority. Export `beforePayment`, `onSettlement`, and `onDelivery` to retain exact intent, facilitator-report, and digest-only delivered-byte observations in the owner’s existing journal. Wallet loading occurs after admission. Ordinary HTTP purchasing uses that owner wallet without requiring private-chain activation.

The reply retains the original request’s canonical ID, context and task, and carries a nonempty message ID and the independently verifiable output byte identity. Requests are bounded to 1 MiB at the command input. No automatic repayment retry is performed.

`purchaseExactResource` additionally retains the private exchange’s OCapN and terminal-delivery contract. Its private account activation remains a separate requirement for that interface.

For private-exchange purchases and the seller, the owner module supplies `openPayer`; the seller reads its module path from `X402_OWNER_MODULE`. An owner that uses the binding validator may call `openEnterpriseAccountPayer` with its own `openSettlementSigner` function. Provisioning an account and controlling its signer are separate capabilities; the buyer never imports an unexported provisioner custody path. The activation materializer requires an explicit `--deployment` manifest and continues to distinguish configured identities from live observation.

## Buyer-owned Rendanheyi/Hoare paid service chains

The original purchase package now exposes `./http-service-chain` with
`executeHttpServiceChain`. This is an **actual buyer-side execution path** for
2–8 separately payable **POST JSON** service cells on one explicitly
denominated x402 network and asset. It is not a second marketplace, seller,
Signer, commercial authority, AOE Work engine, or aggregator custody account.

The caller provides the **original seller's public `marketCatalogReadout`
rows**, independently owner-authorized `expectedPayTo` and `maximumAmount`
**for each cell**, one total atomic spending cap, buyer signer and
owner-controlled egress. Before any purchase the program validates each
published/typed origin and independent payee and requires **the sum of all
per-cell maximum charges to fit within the owner's total chain cap**.
Quoted payment requirements may also be bound per cell using each original
`readHttpPurchaseQuote` result. The seller's own 402 is never approval to
spend or proof of an independently permitted payee.

The owner wires the original components, rather than copies of their
logic, as follows:

```js
import { purchaseHttpResource } from "@red-cup-engineering/x402-exact-purchase-service";
import { executeHttpServiceChain } from "@red-cup-engineering/x402-exact-purchase-service/http-service-chain";
import { projectMarketOfferBody } from "@red-cup-engineering/x402-services-section/market/catalog";
import { validateJsonSchema } from "@red-cup-engineering/json-schema-services-section/validation";

// ownerCells are SOURCE-ADMITTED actual original offers and separate grants.
// They must NOT be populated from a stranger's self-reported 402 payee.
const result = await executeHttpServiceChain({
  stages: ownerCells.map(({ offer, authority }) => ({ offer, authority })),
  initialBody: { /* the first original seller's admitted JSON request */ },
  network: ownerNetwork, asset: ownerAsset, payer: ownerPayer,
  maximumTotalAtomic: authorizedChainCeiling,
  purchaseHttpResource, projectMarketOfferBody,
  validateInput: (offer, body) => validateJsonSchema(body, offer.request.bodySchema),
  validateOutput: (offer, body) => validateJsonSchema(body, offer.output.schema),
  fetchImpl: ownerEgressSafeFetch,
  beforePayment: (index, offer, signedAttempt) => privateAttemptJournal.append(index, offer, signedAttempt),
  onSettlement: (index, offer, settlement) => privateSettlementJournal.append(index, offer, settlement),
  onDelivery: (index, offer, observation) => privateDeliveryJournal.append(index, offer, observation),
  onStage: (observation, receipt) => privateWorkJournal.append(observation, receipt),
});
```

The original Networking `projectMarketOfferBody` alone validates and selects
the **actual paid output's required fields** into the next seller's admitted
JSON Schema. Whole-result forwarding that violates `additionalProperties:
false`, schema mismatch, too-large UTF-8, source/target identity drift, non-JSON
content or output digest mismatch refuse. Each actual `purchaseHttpResource`
uses the independently authorized payee and full x402 protocol and quote
binding, not an unsigned simulation. Every confirmed delivered result has
one original receipt and content digest. `reportedSpendAtomic` is explicitly
a **matching facilitator report**, not independent final chain settlement or
accounting profit.

If a later cell fails or payment status is unknown, the function **never
auto-retries**. It throws with `error.chainProgress` containing the original
earlier purchase receipts, possibly paid current receipt, failure coordinate,
reported spend and `retryAutomatically:false`. The owning enterprise must
reconcile real settlement, recover a purchased result where supported, and
decide whether to create any new authorized Work. Receipt objects and signed
attempts can contain private customer data; the hooks belong to the customer's
**private original journals**, never public page logs.

Independent buyer acceptance, original source/right qualification,
multi-provider x402 merchant installation, revenue/margin allocation,
refunding and AOE/SignGraph resource accounting remain separate downstream
receiving. This source implementation does **not** imply that the canonical
JSON → UTF-8 → NI chain has already been paid on mainnet or that a Bazaar
buyer has completed a purchase.

**Regression:** `node --test test/http-service-chain.test.mjs` covers three
independent cells, exact payees, atomic cap preflight, typed field selection,
late paid-byte corruption, uncertain signed-payment outcome, payee drift,
invalid settlement, source identity/admission failure and journal refusal.
Integration and production release require the actual installed original
Networking JSON Schema supplier and original x402 buyer, secure owner
journals, versioned package consumption and external settlement/delivery
observations; mock receipts are test fixtures, not purchased goods.

### Addressed A2A chain invocation (original x402 buyer)

The existing \`execute-x402-exact-purchase-a2a-message --owner-module OWNER\`
now accepts \`X402HttpServiceChainRequest\`, addressed to
\`urn:ame:x402-exact-purchase-service\`. \`purchase\` is the user's
**proposal**, not a wallet grant, inferred seller catalog or checkout.

The enterprise owner's original \`admitPurchase(proposal)\` must independently
derive a complete \`{stages,initialBody,network,asset,maximumTotalAtomic}\`
from its admitted seller catalog and **its own per-cell rights**, where each
stage has \`{offer,authority:{expectedPayTo,maximumAmount,acceptedQuote?}}\`.
No public endpoint, list of advertised dollar prices or x402 402 header
supplies those authorizations.

The same owner module must export \`openPayer\`, \`purchaseFetch\` (egress
admission), \`validateInput\`, \`validateOutput\`,
\`projectMarketOfferBody\`, \`beforePayment\`, \`onSettlement\`,
\`onDelivery\`, \`onStage\`, and \`onFailure\` as **independently installed
original capabilities**. A2A admission and finite total-budget validation run
BEFORE any wallet opens; absent callbacks refuse without access or spending.
The runtime invokes the one original \`purchaseHttpResource\`, not an
A2A-specific payment implementation. Owner journals must durably retain
pre-payment intent and each settlement/delivery, and on a stopped chain
\`onFailure\` retains \`chainProgress\` privately (including uncertainty).
No automatic retry of prior paid cells occurs.

Successful output is the original content-addressed
\`X402HttpServiceChainResult\`, containing the per-cell original receipts and
final delivered JSON; it makes no claim of independent AOE Work acceptance.
Native tests exercise a three-stage addressed chain and budget/grant/journal
refusals. Source tests or a mock facilitator report are not a real purchase,
deployed signer, external revenue or on-chain settlement.
