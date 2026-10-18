# Native HTTP purchasing

**Canonical package ownership:** this standalone repository is the intended Red Cup source owner for `@red-cup-engineering/x402-exact-purchase-service`. Its embedded same-name predecessor still exists inside `computer-engineering-services-section`; that is a migration source, **not** a second merchant, wallet, or independent buyer authority. Their successor-deployment source blobs coincide, and the standalone package now exports the existing `./successor-deployment` subpath. Their A2A transport, policy-signer custody and activation materialization still differ; removing or rebinding the predecessor requires exact dependency closure and downstream receiving, not blind file deletion. Neither source claims that consolidation or live chain receiving has already occurred.

`purchaseHttpResource` buys an HTTPS representation using the official x402 SDK. The owner supplies the signer, CAIP-10 account, network, token and maximum amount. When recipient identity is independently established, the owner also supplies `expectedPayTo`; an unsigned 402 challenge naming a different recipient is then refused before signing. Optional recipient, asset or payer fields in a facilitator report cannot contradict those admitted terms; a report is still not independent chain settlement proof. `beforePayment` receives the exact request and signed payment before transmission; `onSettlement` receives the facilitator’s report before delivery is read. Retain both in the purchasing enterprise’s own books. A settlement report, received bytes and requester acceptance are distinct observations.

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

The pure `selectExactPaymentRequirement` is shared with `purchaseHttpResource`, so inspections and executed purchases **cannot silently diverge** on which offers are eligible. A matching unsigned offer is not a commitment from the seller, a proof of current market price, or an independent payment/chain receipt. An enterprise can now pass its **owner-admitted** `acceptedQuote` from `readHttpPurchaseQuote` into `purchaseHttpResource`. The one upstream request preparer binds URL, HTTP method, normalized caller-header digest and serialized body digest; before signing, the purchase additionally requires the new 402 to preserve the entire accepted payment requirement (including exact amount, recipient, timeout and token-signing metadata). Request drift is refused before egress; terms drift is refused before a signature, with `X402_QUOTE_DRIFT`. This reduces quote-to-purchase substitution risk but the unsigned quote remains **neither independent merchant authority nor proof of settlement**. Only the enterprise owner's admission can authorize buying, and the owner still supplies its own egress policy and payment-recipient authority.

Operators must re-admit the observed quote during the actual purchase. For broader public, unsigned **GET/HEAD** discovery and Bazaar metadata inspection, the separate `@561-group/x402-boundary-reference/observe` already exists; this API specializes the Engineering buyer to a particular enterprise budget and exact method/body rather than recreating that public catalog product.

For an A2A purchase proposal, run:

```sh
execute-x402-exact-purchase-a2a-message --owner-module /absolute/path/owner.mjs < proposal.json
```

For a **purchase**, the operator-controlled module exports `admitPurchase(proposal)` and `openPayer(admittedPurchase)`. For an unsigned **A2A quote**, send an addressed `X402HttpQuoteRequest` with the same `purchase` proposal; its owner module exports `admitPurchase(proposal)` and `quoteFetch(url, init)` instead. The quote command opens no payer, uses the owner-controlled fetch capability, and returns an addressed `X402HttpQuoteResult` with the exact request, admitted requirement, and explicit no-payment observations. The owner may expose both quote and purchase capabilities in one module. Admission returns the exact URL, network, asset and maximumAmount the owner permits, plus any permitted method, headers and body. Refuse by throwing. The caller’s proposed spending ceiling is not wallet authority. Export `beforePayment`, `onSettlement`, and `onDelivery` to retain exact intent, facilitator-report, and digest-only delivered-byte observations in the owner’s existing journal. Wallet loading occurs after admission. Ordinary HTTP purchasing uses that owner wallet without requiring private-chain activation.

The reply retains the original request’s canonical ID, context and task, and carries a nonempty message ID and the independently verifiable output byte identity. Requests are bounded to 1 MiB at the command input. No automatic repayment retry is performed.

`purchaseExactResource` additionally retains the private exchange’s OCapN and terminal-delivery contract. Its private account activation remains a separate requirement for that interface.

For private-exchange purchases and the seller, the owner module supplies `openPayer`; the seller reads its module path from `X402_OWNER_MODULE`. An owner that uses the binding validator may call `openEnterpriseAccountPayer` with its own `openSettlementSigner` function. Provisioning an account and controlling its signer are separate capabilities; the buyer never imports an unexported provisioner custody path. The activation materializer requires an explicit `--deployment` manifest and continues to distinguish configured identities from live observation.
