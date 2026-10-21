import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { semanticId } from "@red-cup-engineering/relation-model-notation-cbor-codec";
import { ACTOR, executeOperation } from "../src/a2a-executor.mjs";

const network="eip155:8453", asset="0x"+"83".repeat(20);
const payees=["0x"+"aa".repeat(20),"0x"+"bb".repeat(20),"0x"+"cc".repeat(20)];
const makeOffer=(i,operation,input,output)=>({
  sku:`ni:source-${i}`,listed:true,method:"POST",
  url:`https://market.example/v1/data/${operation}`,
  seller:{enterprise:`engineering-cell-${i}`},section:`lib/engineering/${operation}`,
  request:{bodySchema:{type:"object",required:[input],additionalProperties:false,
    properties:{[input]:{type:input==="carrier"?"object":"string"}}}},
  output:{schema:{type:"object",required:[output],properties:{[output]:{type:output==="carrier"?"object":"string"}}}},
});
const offers=[
  makeOffer(0,"json-canonicalize","text","text"),
  makeOffer(1,"text-to-utf8","text","carrier"),
  makeOffer(2,"ni-hash","carrier","uri"),
];
const stages=offers.map((offer,i)=>({offer,authority:{expectedPayTo:payees[i],maximumAmount:"2000"}}));
const admitted={stages,initialBody:{text:'{"z":2,"a":1}'},network,asset,maximumTotalAtomic:"6000"};
const payer={network,caip10:network+":0x"+"11".repeat(20),signer:{address:"0x"+"11".repeat(20)}};
const makeRequest=()=>{
  const body={type:"X402HttpServiceChainRequest",provider:ACTOR,
    purchase:{goal:"canonicalize, encode and hash",untrustedPayee:"0x"+"ff".repeat(20)}};
  return {id:semanticId(body),...body};
};
const inputContract=(offer,body)=>{
  const key=offer.request.bodySchema.required[0];
  return typeof body?.[key]===(key==="carrier"?"object":"string");
};
const outputContract=(offer,body)=>{
  const key=offer.output.schema.required[0];
  return typeof body?.[key]===(key==="carrier"?"object":"string");
};
const projected=(from,to,result)=>{
  const key=to.request.bodySchema.required[0];
  return {from:from.sku,to:to.sku,body:{[key]:result[key]},
    paymentAuthorized:false,executionAuthorized:false};
};
const received=(offer,body,index)=>{
  let output;
  if(index===0)output={text:'{"a":1,"z":2}'};
  else if(index===1)output={carrier:{mediaType:"text/plain;charset=utf-8",
    contentBase64:Buffer.from(body.text).toString("base64")}};
  else {
    const bytes=Buffer.from(body.carrier.contentBase64,"base64");
    output={uri:"ni:///sha-256;"+createHash("sha256").update(bytes).digest("base64url")};
  }
  const bytes=Buffer.from(JSON.stringify(output));
  return {request:{url:offer.url,method:"POST"},
    requirement:{network,asset,amount:"1000",payTo:payees[index]},
    settlementMatchesRequirements:true,status:200,
    delivery:{ok:true,status:200,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),
      contentType:"application/json",encoding:"base64",body:bytes.toString("base64")}};
};
const hooks=(notes)=>({
  validateInput:inputContract,validateOutput:outputContract,projectMarketOfferBody:projected,
  beforePayment:()=>notes.push("intent"),onSettlement:()=>notes.push("settlement"),
  onDelivery:()=>notes.push("delivery"),onStage:(o)=>notes.push("cell:"+o.index),
  onFailure:(progress)=>notes.push("failure:"+progress.failedIndex),
  purchaseFetch:()=>{throw Error("unreachable: native buyer is injected");},
  openPayer:()=>{notes.push("wallet");return payer;},
  purchaseHttpResource:async(args)=>{
    const index=notes.filter(v=>v.startsWith("cell:")).length;
    notes.push("buy:"+index);
    return received(offers[index],args.body,index);
  },
});
test("the same original A2A operator composes three independently admitted x402 cells",async()=>{
  const notes=[];
  const result=await executeOperation(makeRequest(),{
    ...hooks(notes),admitPurchase:()=>structuredClone(admitted),
  });
  assert.equal(result.type,"X402HttpServiceChainResult");
  assert.equal(result.provider,ACTOR);
  assert.equal(result.request,makeRequest().id);
  assert.equal(result.id,semanticId(Object.fromEntries(Object.entries(result).filter(([k])=>k!=="id"))));
  assert.equal(result.result.cells.length,3);
  assert.equal(result.result.reportedSpendAtomic,"3000");
  assert.deepEqual(result.result.cells.map(x=>x.payTo),payees);
  assert.equal(result.result.result.uri,"ni:///sha-256;"+createHash("sha256").update('{"a":1,"z":2}').digest("base64url"));
  assert.equal(result.result.independentlyAcceptedWork,null);
  assert.deepEqual(notes,["wallet","buy:0","cell:0","buy:1","cell:1","buy:2","cell:2"]);
});
test("an A2A chain cannot open a signer for bad payees, budget, body, missing source callbacks or egress",async()=>{
  for(const variant of [
    {maximumTotalAtomic:"5999"},
    {stages:[stages[0],{...stages[1],authority:{maximumAmount:"2000"}},stages[2]]},
    {stages:[stages[0],{...stages[1],offer:{...offers[1],listed:false}},stages[2]]},
    {initialBody:{wrong:true}},
  ]){
    const notes=[];
    await assert.rejects(executeOperation(makeRequest(),{
      ...hooks(notes),admitPurchase:()=>({...admitted,...variant}),
    }));
    assert.deepEqual(notes,[],"invalid chain cannot open payer");
  }
  {
    const notes=[];
    await assert.rejects(executeOperation(makeRequest(),{
      ...hooks(notes),onFailure:undefined,admitPurchase:()=>structuredClone(admitted),
    }),/private journals/);
    assert.deepEqual(notes,[]);
  }
  {
    const notes=[];
    await assert.rejects(executeOperation(makeRequest(),{
      ...hooks(notes),purchaseFetch:undefined,admitPurchase:()=>structuredClone(admitted),
    }),/owner-controlled egress/);
    assert.deepEqual(notes,[]);
  }
});
test("uncertain signed second hop retains private first receipt and records refusal, no third spend",async()=>{
  const notes=[];
  const native=hooks(notes);
  let calls=0, progress;
  native.onFailure=p=>{progress=p;notes.push("failure:"+p.failedIndex)};
  native.purchaseHttpResource=async args=>{
    const index=calls++;
    if(index===1)throw Object.assign(new Error("signed outcome unknown"),{
      code:"X402_PAYMENT_OUTCOME_UNKNOWN",receipt:{settlementStatus:"unconfirmed"}});
    return received(offers[index],args.body,index);
  };
  await assert.rejects(executeOperation(makeRequest(),{
    ...native,admitPurchase:()=>structuredClone(admitted),
  }),error=>{
    assert.equal(error.code,"X402_PAYMENT_OUTCOME_UNKNOWN");
    assert.equal(error.chainProgress.failedIndex,1);
    return true;
  });
  assert.equal(calls,2);
  assert.equal(progress.purchasedReceipts.length,1);
  assert.equal(progress.uncertainReceipt.settlementStatus,"unconfirmed");
  assert.equal(progress.retryAutomatically,false);
  assert.deepEqual(notes,["wallet","cell:0","failure:1"]);
});
