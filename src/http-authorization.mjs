/**
 * Exact-EVM signed HTTP authorization for durable x402 purchasers.
 *
 * Networking and signer mechanics belong to the original Engineering buyer;
 * caller-owned spending approval, secrets, journal and recovery files do not.
 * Producing a replayable PAYMENT-SIGNATURE is NOT sending a payment.
 */
import { x402Client } from "@x402/core/client";
import { isDeepStrictEqual } from "node:util";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  requireOwnerPayee, assertQuotedPurchase, challengeNamesResource,
  prepareHttpResourceRequest, selectExactPaymentRequirement,
} from "./http-quote.mjs";

/** The one official exact-EVM signer registration used by ordinary and
 * durably recoverable HTTP buyers. Callers supply a previously admitted
 * account, network and (if necessary) explicit RPC authority. */
export function exactEvmBuyerClient({ signer, network, rpcUrl } = {}) {
  if (typeof signer?.signTypedData !== "function" ||
      typeof signer?.address !== "string")
    throw new TypeError("x402 buyer requires an owner-held EVM typed-data signer");
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer, networks: [network],
    schemeOptions: rpcUrl === undefined ? {} : { rpcUrl },
  });
  return client;
}

/**
 * Produce ONE EIP-3009 authorization for a previous, unspent signer-free
 * readHttpPurchaseTerms observation, without sending it anywhere.
 *
 * The buyer's explicit original URL/method/representation and owner payee,
 * network, token and ceiling MUST still equal the observed quote. Rechecking
 * the official v2 challenge before opening the signing operation prevents a
 * later caller from substituting a new resource or higher charge.
 *
 * Returned paymentSignature is a replayable credential: the caller must save
 * it privately and durably before any paid send. This operation cannot attest
 * to settlement, delivery, independent merchant identity or buyer acceptance.
 */
export async function authorizeQuotedHttpPayment({
  url, method = "GET", body, headers = {}, terms, payer,
  network, asset, maximumAmount, expectedPayTo, rpcUrl, client,
} = {}) {
  const { request } = prepareHttpResourceRequest({ url, method, body, headers });
  const { payee } = requireOwnerPayee({ network, asset, maximumAmount, expectedPayTo });
  const account = payer?.signer?.address?.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/u.test(account ?? "") ||
      payer?.network !== network ||
      payer?.caip10?.toLowerCase() !== `${network}:${account}`)
    throw new TypeError("durable x402 payer must bind its signer and CAIP-10 account to the admitted network");
  if (!challengeNamesResource(terms?.paymentRequired, request.url))
    throw new TypeError("durable x402 challenge names a different resource");
  const requirement = selectExactPaymentRequirement(terms.paymentRequired, {
    network, asset, maximumAmount, expectedPayTo,
  });
  assertQuotedPurchase(terms.quote, {
    request, requirement, maximumAmount, expectedPayTo: payee,
  });
  const protocol = client ?? exactEvmBuyerClient({
    signer: payer.signer, network, rpcUrl,
  });
  const payload = await protocol.createPaymentPayload({
    ...terms.paymentRequired, accepts: [requirement],
  });
  if (payload?.x402Version !== 2 ||
      !isDeepStrictEqual(payload.accepted, requirement))
    throw new TypeError("official x402 signer returned a different payment authorization");
  return Object.freeze({
    type: "X402PreparedExactHttpAuthorization",
    request,
    requirement: Object.freeze(requirement),
    payer: payer.caip10,
    paymentSignature: encodePaymentSignatureHeader(payload),
    authority: Object.freeze({
      signingAttempted: true, paymentAttempted: false,
      settlementObserved: false, deliveryObserved: false,
    }),
  });
}
