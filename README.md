# Native HTTP purchasing

`purchaseHttpResource` buys an HTTPS representation using the official x402 SDK. The owner supplies the signer, CAIP-10 account, network, token and maximum amount. `beforePayment` receives the exact request and signed payment before transmission; `onSettlement` receives the facilitator’s report before delivery is read. Retain both in the purchasing enterprise’s own books. A settlement report, received bytes and requester acceptance are distinct observations.

For an A2A purchase proposal, run:

```sh
execute-x402-exact-purchase-a2a-message --owner-module /absolute/path/owner.mjs < proposal.json
```

The operator-controlled module must export `admitPurchase(proposal)` and `openPayer(admittedPurchase)`. Admission returns the exact URL, network, asset and maximumAmount the owner permits, plus any permitted method, headers and body. Refuse by throwing. The caller’s proposed spending ceiling is not wallet authority. Export `beforePayment` and `onSettlement` to retain observations in the owner’s existing journal. Wallet loading occurs after admission. Ordinary HTTP purchasing uses that owner wallet without requiring private-chain activation.

The reply retains the original request’s canonical ID, context and task, and carries a nonempty message ID and the independently verifiable output byte identity. Requests are bounded to 1 MiB at the command input. No automatic repayment retry is performed.

`purchaseExactResource` additionally retains the private exchange’s OCapN and terminal-delivery contract. Its private account activation remains a separate requirement for that interface.
