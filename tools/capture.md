# Capturing real Auchan responses

Read-only, passive capture through the logged-in chrome-devtools MCP browser. Never call
`get_network_request` (it returns cookies). Never send requests yourself (no fetch, no replay);
only record what the app requests during normal navigation. Pace navigations >= 1500 ms. Stop on 403/429.
Raw output goes to `tests/fixtures/raw/` (git-ignored, personal data). Sanitise before committing fixtures.

## /orders and /orders/<id>/details (GraphQL + REST)
Wrapping `fetch` and cloning the response fails (Apollo aborts its signal, the clone errors with AbortError).
Hook `Response.prototype.json` / `.text` instead and record the result of the original call:

```js
navigate_page({ type: 'url', url: 'https://zakupy.auchan.pl/orders', initScript: `(()=>{
  window.__rec=[]; window.__req=[];
  const P=Response.prototype;
  for (const m of ['json','text']) { const o=P[m]; P[m]=function(){
    const url=this.url, pr=o.apply(this,arguments);
    if (/graphql|\\/api\\/order\\//.test(url)) pr.then(v=>{ try{ window.__rec.push({url, data: m==='json'?v:JSON.parse(v)}) }catch(e){} }).catch(()=>{});
    return pr; } }
  const f=window.fetch; window.fetch=function(i,init){
    const u=typeof i==='string'?i:i.url;
    if (/graphql/.test(u)) { try{ const b=JSON.parse(init.body); window.__req.push({operationName:b.operationName,query:b.query,variables:b.variables}) }catch(e){} }
    return f.apply(this,arguments) } })()` })
```
Headers are never recorded. Then `evaluate_script` with `filePath` to save:
- `/orders`: `GetCompletedOrders` response (`data.customer.ordersCompleted`) -> `tests/fixtures/raw/completed-orders.raw.json`;
  query text -> `src/queries/GetCompletedOrders.graphql`.
- `/orders/<id>/details`: the `/api/order/v6/orders/<id>/decorated` response -> `raw/order-decorated.raw.json`.

## /promotions (SSR state)
No hook needed. Save `{session:{metadata:{regionId}}, data:{products:{productEntities}}}` taken from
`window.__INITIAL_STATE__` (regionId lives at `session.metadata.regionId`) -> `raw/promotions-state.raw.json`.

## Sanitising
Reduce to 3 orders / 5 products. Drop address, addressId, slotId, fulfillmentId, deliveryDestinationId,
billingAddressDetails, payment/loyalty fields, destination name. Renumber order ids from 1000000001.
Check: `grep -riE 'addressId|deliveryDestination|"address"' tests/fixtures/*.json` must print nothing.
