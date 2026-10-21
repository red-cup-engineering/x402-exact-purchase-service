import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { executeHttpServiceChain } from "../src/http-service-chain.mjs";

const network = "eip155:8453";
const asset = "0x" + "83".repeat(20);
const payer = { network, caip10: `${network}:0x${"11".repeat(20)}` };
const payees = ["0x" + "aa".repeat(20), "0x" + "bb".repeat(20), "0x" + "cc".repeat(20)];
const source = (i, field, nextField) => ({
  sku: `ni:source-${i}`, listed: true, method: "POST",
  url: `https://seller-${i}.example/v1/data/${i}`,
  seller: { enterprise: `microenterprise-${i}` },
  section: `lib/emsenn/services/561-group/services/section-${i}-services-section`,
  request: { bodySchema: {type:"object",required:[field],additionalProperties:false,
    properties: {[field]:{type:"string"}}}},
  output: {schema:{type:"object",required:[nextField],additionalProperties:false,
    properties:{[nextField]:{type:"string"}}}},
});
const stages = [source(0,"raw","text"),source(1,"text","carrier"),source(2,"carrier","uri")]
  .map((offer,i) => ({offer,authority:{expectedPayTo:payees[i],maximumAmount:"20"}}));
const fieldFor = offer => offer.request.bodySchema.required[0];
const outputFor = offer => offer.output.schema.required[0];
const payloadOf = (offer, body) => ({[outputFor(offer)]: body[fieldFor(offer)] + "!"});
const project = (from,to,result) => ({
  from:from.sku,to:to.sku, paymentAuthorized:false,executionAuthorized:false,
  body: {[fieldFor(to)]:result[fieldFor(to)]},
});
const validation = (schema,body) => schema.required.every(k=>typeof body?.[k]==="string") &&
  Object.keys(body).every(k=>schema.required.includes(k));
const validateInput = (offer,body) => validation(offer.request.bodySchema,body);
const validateOutput = (offer,body) => validation(offer.output.schema,body);
const delivered = (offer,body,amount,payee) => {
  const bytes = Buffer.from(JSON.stringify(payloadOf(offer,body)));
  return {
    request:{url:offer.url,method:"POST"}, requirement:{network,asset,payTo:payee,amount},
    settlementMatchesRequirements:true,status:200,
    delivery:{ok:true,contentType:"application/json; charset=utf-8",bytes:bytes.length,
      sha256:createHash("sha256").update(bytes).digest("hex"),encoding:"base64",body:bytes.toString("base64")},
  };
};
const mock = (events, f = delivered) => async args => {
  const index = events.length;
  events.push({url:args.url,body:args.body,payTo:args.expectedPayTo,max:args.maximumAmount});
  return f(stages[index].offer,args.body,"5",args.expectedPayTo);
};
const run = (overrides={}) => executeHttpServiceChain({
  stages, initialBody:{raw:"data"}, payer, network,asset,maximumTotalAtomic:"60",
  validateInput,validateOutput,projectMarketOfferBody:project,
  fetchImpl:()=>{throw Error("no real network in test")},
  beforePayment:()=>{}, onSettlement:()=>{}, onDelivery:()=>{}, onStage:()=>{},
  ...overrides,
});

test("three separately authorized cells purchase in order and retain per-seller receipts",async()=>{
  const events=[];
  const result=await run({purchaseHttpResource:mock(events)});
  assert.deepEqual(events.map(e=>e.body),[{raw:"data"},{text:"data!"},{carrier:"data!!"}]);
  assert.deepEqual(events.map(e=>e.payTo),payees);
  assert.equal(result.reportedSpendAtomic,"15");
  assert.equal(result.maximumTotalAtomic,"60");
  assert.equal(result.cells.length,3);
  assert.deepEqual(result.cells.map(c=>c.sourceSeller),["microenterprise-0","microenterprise-1","microenterprise-2"]);
  assert.deepEqual(result.result,{uri:"data!!!"});
  assert.equal(result.independentlyAcceptedWork,null);
  assert.ok(result.cells.every(c=>c.independentlyAcceptedWork===null));
  assert.equal(result.purchasedReceipts.length,3);
});

test("preflight budget, authority, source listings, typed input and URL refuse before debit",async()=>{
  for (const overrides of [
    {maximumTotalAtomic:"59"},
    {maximumTotalAtomic:"-1"},
    {maximumTotalAtomic:"01"},
    {initialBody:{incorrect:"data"}},
    {stages:[stages[0],{...stages[1],authority:{maximumAmount:"20"}},stages[2]]},
    {stages:[stages[0],{...stages[1],offer:{...stages[1].offer,listed:false}},stages[2]]},
    {stages:[stages[0],{...stages[1],offer:{...stages[1].offer,url:"http://seller.example"}},stages[2]]},
    {stages:[stages[0],{...stages[1],authority:{...stages[1].authority,unknown:true}},stages[2]]},
    {stages:[stages[0]]},
  ]) {
    const events=[];
    await assert.rejects(run({...overrides,purchaseHttpResource:mock(events)}));
    assert.equal(events.length,0,"no paid call admitted after preflight refusal");
  }
});

test("partial purchase followed by corrupt paid bytes retains earlier receipts and never retries",async()=>{
  const events=[];
  const purchase=mock(events,(offer,body,amount,payee)=>{
    const receipt=delivered(offer,body,amount,payee);
    if(events.length===2) receipt.delivery.sha256="bad";
    return receipt;
  });
  await assert.rejects(run({purchaseHttpResource:purchase}),error=>{
    assert.equal(error.chainProgress.failedIndex,1);
    assert.equal(error.chainProgress.reportedSpendAtomic,"10");
    assert.equal(error.chainProgress.completed.length,1);
    assert.equal(error.chainProgress.purchasedReceipts.length,2);
    assert.equal(error.chainProgress.retryAutomatically,false);
    return true;
  });
  assert.equal(events.length,2);
});

test("signed payment uncertainty preserves the native buyer receipt and aborts remaining cells",async()=>{
  const events=[];
  const purchase=async args=>{
    events.push(args.url);
    if(events.length===2) {
      const error=Object.assign(new Error("unknown signed outcome"),{
        code:"X402_PAYMENT_OUTCOME_UNKNOWN",receipt:{settlementStatus:"unconfirmed"},
      });
      throw error;
    }
    return delivered(stages[0].offer,args.body,"4",args.expectedPayTo);
  };
  await assert.rejects(run({purchaseHttpResource:purchase}),error=>{
    assert.equal(error.code,"X402_PAYMENT_OUTCOME_UNKNOWN");
    assert.equal(error.chainProgress.completed.length,1);
    assert.deepEqual(error.chainProgress.uncertainReceipt,{settlementStatus:"unconfirmed"});
    assert.equal(error.chainProgress.retryAutomatically,false);
    return true;
  });
  assert.equal(events.length,2);
});

test("different payee, overpaid cell and unverified settlement never pass as valid purchase",async()=>{
  for(const mutate of [
    receipt=>{receipt.requirement.payTo=payees[2]},
    receipt=>{receipt.requirement.amount="21"},
    receipt=>{receipt.settlementMatchesRequirements=false},
    receipt=>{receipt.delivery.contentType="text/plain"},
  ]){
    const events=[];
    const purchase=mock(events,(offer,body,amount,payee)=>{
      const receipt=delivered(offer,body,amount,payee);
      if(events.length===1)mutate(receipt);
      return receipt;
    });
    await assert.rejects(run({purchaseHttpResource:purchase}),error=>{
      assert.equal(error.chainProgress.failedIndex,0);
      assert.equal(error.chainProgress.purchasedReceipts.length,1);
      return true;
    });
    assert.equal(events.length,1);
  }
});

test("schema projection refusal after a settled cell halts and retains receipt",async()=>{
  const events=[];
  await assert.rejects(run({purchaseHttpResource:mock(events),projectMarketOfferBody:()=>{
    throw new TypeError("target input schema mismatch");
  }}),error=>{
    assert.equal(error.chainProgress.completed.length,1);
    assert.equal(error.chainProgress.purchasedReceipts.length,1);
    return true;
  });
  assert.equal(events.length,1);
});

test("source identity mismatch, forged authorization, and final output refusal stop",async()=>{
  for(const returned of [
    {from:"ni:other",to:stages[1].offer.sku,body:{text:"data!"},paymentAuthorized:false,executionAuthorized:false},
    {from:stages[0].offer.sku,to:stages[1].offer.sku,body:{text:"data!"},paymentAuthorized:true,executionAuthorized:false},
    {from:stages[0].offer.sku,to:stages[1].offer.sku,body:{no:"wrong"},paymentAuthorized:false,executionAuthorized:false},
  ]){
    const events=[];
    await assert.rejects(run({purchaseHttpResource:mock(events),projectMarketOfferBody:()=>returned}));
    assert.equal(events.length,1);
  }
  const events=[];
  const v=async(offer,body)=>offer.sku===stages[2].offer.sku? false:validateOutput(offer,body);
  await assert.rejects(run({purchaseHttpResource:mock(events),validateOutput:v}),error=>{
    assert.equal(error.chainProgress.completed.length,2);
    assert.equal(error.chainProgress.purchasedReceipts.length,3);
    return true;
  });
});

test("journaling failure retains receipt and does not advance",async()=>{
  const events=[];
  await assert.rejects(run({purchaseHttpResource:mock(events),onStage:()=>{throw Error("journal unavailable")}}),error=>{
    assert.equal(error.message,"journal unavailable");
    assert.equal(error.chainProgress.completed.length,1);
    assert.equal(error.chainProgress.purchasedReceipts.length,1);
    return true;
  });
  assert.equal(events.length,1);
});
