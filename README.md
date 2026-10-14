# Native HTTP purchasing

**Migration status:** this in-tree same-name package is a predecessor to the standalone canonical source [`red-cup-engineering/x402-exact-purchase-service`](https://github.com/red-cup-engineering/x402-exact-purchase-service). Its successor-deployment implementation matches the standalone owner's blob, but the A2A adapter, custody binding and activation materializer are *not* equivalent. It remains until each consumer moves through a verified package/Guix closure. Do not independently publish or deploy it as a second buyer, payment custodian, or marketplace; this is not yet a completed cutover.

`purchaseHttpResource` buys an HTTPS representation using the official x402 SDK. The owner supplies the signer, CAIP-10 account, network, token and maximum amount. `beforePayment` receives the exact request and signed payment before transmission; `onSettlement` receives the facilitator’s report before delivery is read. Retain both in the purchasing enterprise’s own books. A settlement report, received bytes and requester acceptance are distinct observations.

For an A2A purchase proposal, run:

```sh
execute-x402-exact-purchase-a2a-message --owner-module /absolute/path/owner.mjs < proposal.json
```

The operator-controlled module must export `admitPurchase(proposal)` and `openPayer(admittedPurchase)`. Admission returns the exact URL, network, asset and maximumAmount the owner permits, plus any permitted method, headers and body. Refuse by throwing. The caller’s proposed spending ceiling is not wallet authority. Export `beforePayment`, `onSettlement`, and `onDelivery` to retain exact intent, facilitator-report, and digest-only delivered-byte observations in the owner’s existing journal. Wallet loading occurs after admission. Ordinary HTTP purchasing uses that owner wallet without requiring private-chain activation.

The reply retains the original request’s canonical ID, context and task, and carries a nonempty message ID and the independently verifiable output byte identity. Requests are bounded to 1 MiB at the command input. No automatic repayment retry is performed.

`purchaseExactResource` additionally retains the private exchange’s OCapN and terminal-delivery contract. Its private account activation remains a separate requirement for that interface.
