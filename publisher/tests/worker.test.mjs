/*
 * 发布接口验证：所有者与白名单授权、移除后的旧会话、OAuth、清单及冲突保护。
 * 使用临时密钥和模拟GitHub响应，不读取或输出真实凭据。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHmac,randomBytes} from 'node:crypto';
import {handle,validateSnapshot} from '../worker.mjs';
const env={GITHUB_OWNER:'owner',GITHUB_REPO:'trip',GITHUB_BRANCH:'main',GITHUB_OWNER_ID:'42',FRONTEND_URL:'https://example.github.io/trip/',GITHUB_CLIENT_ID:'test-client',GITHUB_CLIENT_SECRET:'test-secret',SESSION_SECRET:randomBytes(32).toString('base64url'),GITHUB_PRIVATE_KEY:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'})};
const empty=()=>({format:'russia-trip-checklists',version:1,collections:Object.fromEntries(['days','tickets','transportCosts','groundCosts','hotels','packingGroups','packingItems','activities','specialItems'].map(k=>[k,[]])),checked:{}});
const sign=(uid='42')=>{const body=Buffer.from(JSON.stringify({purpose:'session',uid,login:'owner',exp:Math.floor(Date.now()/1000)+600})).toString('base64url');return body+'.'+createHmac('sha256',Buffer.from(env.SESSION_SECRET,'base64url')).update(body).digest('base64url');};
const req=(path='/publish',options={})=>new Request('https://worker.example'+path,{method:'POST',headers:{Origin:'https://example.github.io',Authorization:'Bearer '+sign(),'Content-Type':'application/json'},body:JSON.stringify({expectedSha:'old',snapshot:empty()}),...options});
test('拒绝外站、未登录和其他账号',async()=>{
 assert.equal((await handle(req('/publish',{headers:{Origin:'https://evil.example'}}),env)).status,403);
 assert.equal((await handle(req('/publish',{headers:{Origin:'https://example.github.io'}}),env)).status,401);
 assert.equal((await handle(req('/publish',{headers:{Origin:'https://example.github.io',Authorization:'Bearer invalid'}}),env)).status,401);
 assert.equal((await handle(req('/publish',{headers:{Origin:'https://example.github.io',Authorization:'Bearer '+sign('99')}}),env)).status,403);
});
test('校验物品分类、金额、重复ID与无效链接',()=>{
 const value=empty();value.collections.packingItems=[{id:'x',groupId:'missing',name:'相机'}];assert.throws(()=>validateSnapshot(value));
 value.collections.packingItems=[];value.collections.transportCosts=[{id:'x',item:'车票',currency:'CNY',actual:'-1'}];assert.throws(()=>validateSnapshot(value));
 value.collections.transportCosts=[];value.collections.activities=[{id:'x',name:'路线',link:'javascript:alert(1)'}];assert.throws(()=>validateSnapshot(value));
 value.collections.activities=[{id:'x',name:'甲'},{id:'x',name:'乙'}];assert.throws(()=>validateSnapshot(value));
});
test('OAuth校验绑定浏览器Cookie与state，并拒绝其他账号',async()=>{
 const original=globalThis.fetch;
 try{
  const start=await handle(new Request('https://worker.example/auth/start?tab=packing'),env);
  assert.equal(start.status,302);
  const location=new URL(start.headers.get('Location')),cookie=start.headers.get('Set-Cookie').split(';')[0];
  assert.equal(location.searchParams.get('code_challenge_method'),'S256');
  const callback=(state)=>new Request('https://worker.example/auth/callback?code=test&state='+state,{headers:{Cookie:cookie}});
  assert.equal((await handle(callback('wrong'),env)).status,401);
  globalThis.fetch=async(url)=>new Response(JSON.stringify(String(url).includes('access_token')?{access_token:'temporary'}:{id:99,login:'other'}));
  assert.equal((await handle(callback(location.searchParams.get('state')),env)).status,403);
  globalThis.fetch=async(url)=>new Response(JSON.stringify(String(url).includes('access_token')?{access_token:'temporary'}:{id:42,login:'owner'}));
  const result=await handle(callback(location.searchParams.get('state')),env);
  assert.equal(result.status,302);
  assert.ok(result.headers.get('Location').startsWith(env.FRONTEND_URL+'#packing&publish_session='));
 }finally{globalThis.fetch=original;}
});
test('版本冲突拒绝写入，成功提交固定文件，相同内容不重复提交',async()=>{
 const original=globalThis.fetch;let puts=0;
 let remote={sha:'old',snapshot:empty()};
 globalThis.fetch=async(url,options={})=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/installation'))return new Response(JSON.stringify({id:1}));
  if(path.endsWith('/access_tokens'))return new Response(JSON.stringify({token:'installation',expires_at:new Date(Date.now()+3600000).toISOString()}));
  assert.equal(path,'/repos/owner/trip/contents/published-checklists.json');
  if(options.method==='PUT'){
   puts++;const body=JSON.parse(options.body);assert.equal(body.sha,'old');assert.equal(body.branch,'main');
   remote={sha:'new',snapshot:JSON.parse(Buffer.from(body.content,'base64').toString('utf8'))};
   return new Response(JSON.stringify({content:{sha:'new'},commit:{sha:'commit'}}));
  }
  return new Response(JSON.stringify({sha:remote.sha,content:Buffer.from(JSON.stringify(remote.snapshot)).toString('base64')}));
 };
 try{
  const value=empty();value.collections.packingGroups=[{id:'g',title:'摄影器材'}];
  const send=(expectedSha)=>handle(req('/publish',{body:JSON.stringify({expectedSha,snapshot:value})}),env);
  assert.equal((await send('stale')).status,409);assert.equal(puts,0);
  const first=await send('old');assert.equal(first.status,200);assert.equal((await first.json()).sha,'new');assert.equal(puts,1);
  const second=await send('old');assert.equal(second.status,200);assert.equal((await second.json()).alreadyPublished,true);assert.equal(puts,1);
 }finally{globalThis.fetch=original;}
});

test('白名单允许其他用户登录并发布，移除后同一会话失效',async()=>{
 const original=globalThis.fetch;
 const allowed={...env,GITHUB_PUBLISHER_IDS:' 77, 88, , invalid '};
 let writes=0;
 const remote=empty();
 try {
  const start=await handle(new Request('https://worker.example/auth/start?tab=packing'),allowed);
  const location=new URL(start.headers.get('Location')),cookie=start.headers.get('Set-Cookie').split(';')[0];
  const callback=()=>new Request('https://worker.example/auth/callback?code=test&state='+location.searchParams.get('state'),{headers:{Cookie:cookie}});
  globalThis.fetch=async(url,options={})=>{
   if(String(url).includes('/login/oauth/access_token')) return new Response(JSON.stringify({access_token:'temporary'}));
   if(new URL(url).pathname==='/user') return new Response(JSON.stringify({id:77,login:'collaborator'}));
   if(String(url).endsWith('/installation')) return new Response(JSON.stringify({id:1}));
   if(String(url).endsWith('/access_tokens')) return new Response(JSON.stringify({token:'installation',expires_at:new Date(Date.now()+3600000).toISOString()}));
   if(options.method==='PUT') writes++;
   return new Response(JSON.stringify({sha:'current',content:Buffer.from(JSON.stringify(remote)).toString('base64')}));
  };
  const login=await handle(callback(),allowed);
  assert.equal(login.status,302);
  const session=new URLSearchParams(new URL(login.headers.get('Location')).hash.split('&').slice(1).join('&')).get('publish_session');
  assert.ok(session);
  const send=()=>req('/publish',{headers:{Origin:'https://example.github.io',Authorization:'Bearer '+session}});
  const result=await handle(send(),allowed);
  assert.equal(result.status,200);assert.equal((await result.json()).alreadyPublished,true);
  assert.equal((await handle(send(),{...allowed,GITHUB_PUBLISHER_IDS:''})).status,403);
  assert.equal((await handle(callback(),{...allowed,GITHUB_PUBLISHER_IDS:''})).status,403);
  assert.equal(writes,0);
 } finally {globalThis.fetch=original;}
});
test('空名单与缺少配置仅保留所有者，非法或近似ID不放行',async()=>{
 for(const list of ['',undefined,'7,770,invalid']) {
  const config={...env,GITHUB_PUBLISHER_IDS:list};
  const response=await handle(req('/publish',{headers:{Origin:'https://example.github.io',Authorization:'Bearer '+sign('77')}}),config);
  assert.equal(response.status,403);
 }
 for(const id of ['','undefined','invalid',' 77','077']) {
  const config={...env,GITHUB_PUBLISHER_IDS:'77'};
  const response=await handle(req('/publish',{headers:{Origin:'https://example.github.io',Authorization:'Bearer '+sign(id)}}),config);
  assert.equal(response.status,403);
 }
});
