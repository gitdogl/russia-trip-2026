/*
 * 旅行清单发布接口：允许仓库所有者和白名单用户登录，只写固定仓库中的清单JSON。
 * GitHub App私钥与会话签名密钥由Workers Secrets提供，不返回给浏览器。
 * 登录与每次发布均按GitHub用户ID核对当前白名单；移除用户后旧会话也失去权限。
 * 写入前比较文件SHA；版本冲突时拒绝覆盖，重复内容不重复提交。
 */
const FILE = 'published-checklists.json';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fields = {
  days: ['date','city','plan','note','stay'],
  tickets: ['window','route','mode','status','number','from','to','departure','arrival','price','note'],
  transportCosts: ['window','item','status','currency','budget','actual','paid','note'],
  groundCosts: ['window','item','mode','status','currency','budget','actual','paid','note'],
  hotels: ['city','nights','plannedNights','status','name','roomType','checkIn','checkOut','rooms','currency','budget','actual','paid','note'],
  packingGroups: ['title','description'],
  packingItems: ['groupId','name','quantity','model','tag','note'],
  activities: ['name','kind','date','time','city','address','route','note','link'],
  specialItems: ['name','phase','status','deadline','note','link']
};
const required = {days:['date','city'],tickets:['route'],transportCosts:['item'],groundCosts:['item'],hotels:['city'],packingGroups:['title'],packingItems:['groupId','name'],activities:['name'],specialItems:['name']};
let tokenCache = null;

function fail(status,message) { throw Object.assign(new Error(message),{status}); }
// 所有者始终保留权限；额外名单为空时只允许所有者，按ID匹配避免用户名变更或复用。
function requirePublisher(uid,env) {
  const id=String(uid??'');
  const allowed=[String(env.GITHUB_OWNER_ID||''),...String(env.GITHUB_PUBLISHER_IDS||'').split(',').map(value=>value.trim())];
  if(!/^[1-9]\d*$/.test(id)||!allowed.includes(id)) fail(403,'当前账号不在发布白名单中，请联系页面所有者添加。');
}
function base64(bytes) {
  let text=''; for(let i=0;i<bytes.length;i+=8192) text+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(text);
}
function from64(value) { return Uint8Array.from(atob(value),char=>char.charCodeAt(0)); }
function b64url(bytes) { return base64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function unurl(value) { return from64(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4)); }
function random() { return b64url(crypto.getRandomValues(new Uint8Array(32))); }
function now() { return Math.floor(Date.now()/1000); }
function configured(env) { return ['GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_PRIVATE_KEY','SESSION_SECRET'].every(key=>env[key]); }
async function hmacKey(env) { return crypto.subtle.importKey('raw',unurl(env.SESSION_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']); }
async function sign(value,env) {
  const body=b64url(encoder.encode(JSON.stringify(value)));
  return body+'.'+b64url(new Uint8Array(await crypto.subtle.sign('HMAC',await hmacKey(env),encoder.encode(body))));
}
async function verify(value,env,purpose) {
  try {
    const parts=value.split('.');
    if(parts.length!==2||!await crypto.subtle.verify('HMAC',await hmacKey(env),unurl(parts[1]),encoder.encode(parts[0]))) fail(401,'登录状态无效，请重新登录。');
    const data=JSON.parse(decoder.decode(unurl(parts[0])));
    if(data.purpose!==purpose||!Number.isFinite(data.exp)||data.exp<=now()) fail(401,'登录已过期，请重新登录。');
    return data;
  } catch(error) { fail(401,'登录状态无效或已过期，请重新登录。'); }
}
function headers(env,origin='') {
  const result={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
  if(origin===new URL(env.FRONTEND_URL).origin) Object.assign(result,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Max-Age':'3600','Vary':'Origin'});
  return result;
}
function json(value,status,env,origin) { return new Response(JSON.stringify(value),{status,headers:headers(env,origin)}); }
async function github(path,env,authorization,options={}) {
  const response=await fetch('https://api.github.com'+path,{...options,headers:{'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'RussiaTripPublisher','Authorization':'Bearer '+authorization,...options.headers}});
  if(response.status===404) return null;
  if(response.status===409||response.status===422) fail(409,'云端文件已变化，请先读取最新版本再发布。');
  if(!response.ok) fail(502,'GitHub请求未完成，请稍后重试或检查应用的仓库授权。');
  return response.json();
}
async function appJwt(env) {
  const header=b64url(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})));
  const payload=b64url(encoder.encode(JSON.stringify({iat:now()-60,exp:now()+540,iss:env.GITHUB_CLIENT_ID})));
  const pem=env.GITHUB_PRIVATE_KEY.replace(/-----[^-]+-----/g,'').replace(/\s/g,'');
  const key=await crypto.subtle.importKey('pkcs8',from64(pem),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const input=header+'.'+payload;
  return input+'.'+b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(input))));
}
async function installationToken(env) {
  if(tokenCache&&tokenCache.client===env.GITHUB_CLIENT_ID&&tokenCache.exp>Date.now()+60000) return tokenCache.value;
  const jwt=await appJwt(env);
  const installation=await github('/repos/'+env.GITHUB_OWNER+'/'+env.GITHUB_REPO+'/installation',env,jwt);
  if(!installation) fail(503,'GitHub应用尚未安装到旅行仓库。');
  const token=await github('/app/installations/'+installation.id+'/access_tokens',env,jwt,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({repositories:[env.GITHUB_REPO],permissions:{contents:'write'}})});
  tokenCache={client:env.GITHUB_CLIENT_ID,value:token.token,exp:Date.parse(token.expires_at)};
  return token.token;
}
function repoPath(env) { return '/repos/'+env.GITHUB_OWNER+'/'+env.GITHUB_REPO+'/contents/'+FILE; }
async function readRemote(env) {
  const file=await github(repoPath(env)+'?ref='+encodeURIComponent(env.GITHUB_BRANCH),env,await installationToken(env));
  if(!file) return {sha:null,snapshot:null};
  try { return {sha:file.sha,snapshot:JSON.parse(decoder.decode(from64(file.content.replace(/\s/g,''))))}; }
  catch(error) { fail(502,'云端清单文件格式异常，暂不执行覆盖。'); }
}
export function validateSnapshot(value) {
  if(!value||value.format!=='russia-trip-checklists'||value.version!==1||!value.collections) fail(400,'清单格式不正确。');
  const collections={};
  for(const [key,names] of Object.entries(fields)) {
    const list=value.collections[key];
    if(!Array.isArray(list)||list.length>5000) fail(400,'清单条目格式或数量不正确。');
    const ids=new Set();
    collections[key]=list.map(raw=>{
      if(!raw||typeof raw.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(raw.id)||['__proto__','constructor','prototype'].includes(raw.id)||ids.has(raw.id)) fail(400,'清单存在无效或重复标识。');
      ids.add(raw.id);
      const row={id:raw.id};
      for(const name of names) {
        if(raw[name]!=null&&!['string','number'].includes(typeof raw[name])) fail(400,'清单字段类型不正确。');
        row[name]=String(raw[name]??'');
        if(row[name].length>20000) fail(400,'清单字段内容过长。');
      }
      if(required[key].some(name=>!row[name].trim())) fail(400,'清单缺少必填字段。');
      if(row.link&&!/^https?:\/\//i.test(row.link)) fail(400,'参考链接必须使用http或https。');
      if(['transportCosts','groundCosts','hotels'].includes(key)) {
        for(const name of ['budget','actual','paid']) if(row[name]&&(!/^\d+(\.\d{1,2})?$/.test(row[name])||!Number.isFinite(Number(row[name])))) fail(400,'费用金额格式不正确。');
        if(['budget','actual','paid'].some(name=>row[name]!=='')&&!['CNY','RUB'].includes(row.currency)) fail(400,'填写金额时须选择币种。');
      }
      if(key==='hotels'&&row.rooms&&!/^[1-9]\d*$/.test(row.rooms)) fail(400,'住宿间数须为正整数。');
      if(key==='packingItems') {
        row.basis=['verified','suggestion','video','user'].includes(raw.basis)?raw.basis:'user';
        row.sources=Array.isArray(raw.sources)?raw.sources.filter(id=>typeof id==='string'&&id.length<100).slice(0,20):[];
      }
      return row;
    });
  }
  const groups=new Set(collections.packingGroups.map(group=>group.id));
  if(collections.packingItems.some(item=>!groups.has(item.groupId))) fail(400,'物品所属分类不存在。');
  const checked={};
  collections.packingItems.forEach(item=>{if(value.checked?.[item.id]===true) checked[item.id]=true;});
  return {format:'russia-trip-checklists',version:1,collections,checked};
}
function canonical(value) {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
async function readBody(request) {
  if(!request.body) fail(400,'请求内容为空。');
  const reader=request.body.getReader();let length=0;const chunks=[];
  while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>2*1024*1024){await reader.cancel();fail(413,'清单大小不能超过2MB。')}chunks.push(part.value);}
  const bytes=new Uint8Array(length);let offset=0;chunks.forEach(chunk=>{bytes.set(chunk,offset);offset+=chunk.length;});
  try{return JSON.parse(decoder.decode(bytes));}catch(error){fail(400,'请求不是有效的JSON。');}
}
async function authStart(request,env) {
  const url=new URL(request.url);const tab=['travel','packing','routes','special'].includes(url.searchParams.get('tab'))?url.searchParams.get('tab'):'packing';
  const nonce=random(),verifier=random();
  const state=await sign({purpose:'oauth',nonce,verifier,tab,exp:now()+600},env);
  const target=new URL('https://github.com/login/oauth/authorize');
  target.search=new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,redirect_uri:url.origin+'/auth/callback',state:nonce,code_challenge:b64url(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(verifier)))),code_challenge_method:'S256'});
  return new Response(null,{status:302,headers:{'Location':target.href,'Set-Cookie':'trip_oauth='+state+'; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
async function authCallback(request,env) {
  const url=new URL(request.url);
  const cookie=(request.headers.get('Cookie')||'').split(';').map(value=>value.trim()).find(value=>value.startsWith('trip_oauth='));
  if(!cookie) fail(401,'授权校验已过期，请重新从博客登录。');
  const flow=await verify(cookie.slice(11),env,'oauth');
  if(url.searchParams.get('state')!==flow.nonce||!url.searchParams.get('code')) fail(401,'授权校验未通过。');
  const response=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code:url.searchParams.get('code'),redirect_uri:url.origin+'/auth/callback',code_verifier:flow.verifier})});
  const token=await response.json();
  if(!response.ok||!token.access_token) fail(401,'GitHub授权未完成，请重试。');
  const user=await github('/user',env,token.access_token);
  requirePublisher(user?.id,env);
  const session=await sign({purpose:'session',uid:String(user.id),login:user.login,exp:now()+8*3600},env);
  const target=new URL(env.FRONTEND_URL);
  target.hash=flow.tab+'&publish_session='+session;
  return new Response(null,{status:302,headers:{'Location':target.href,'Set-Cookie':'trip_oauth=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
}
export async function handle(request,env) {
  const origin=request.headers.get('Origin')||'';const url=new URL(request.url);
  try {
    if(url.pathname==='/health') return json({ok:true,configured:!!configured(env)},200,env,origin);
    if(!configured(env)) fail(503,'发布服务正在配置，请稍后再试。');
    if(url.pathname==='/auth/start'&&request.method==='GET') return await authStart(request,env);
    if(url.pathname==='/auth/callback'&&request.method==='GET') return await authCallback(request,env);
    if(origin!==new URL(env.FRONTEND_URL).origin) fail(403,'请求来源不受支持。');
    if(request.method==='OPTIONS') return new Response(null,{status:204,headers:headers(env,origin)});
    if(url.pathname==='/snapshot'&&request.method==='GET') return json(await readRemote(env),200,env,origin);
    if(url.pathname!=='/publish'||request.method!=='POST') fail(404,'接口不存在。');
    const authorization=request.headers.get('Authorization')||'';
    if(!authorization.startsWith('Bearer ')) fail(401,'请先登录GitHub。');
    const session=await verify(authorization.slice(7),env,'session');
    requirePublisher(session.uid,env);
    const body=await readBody(request);const snapshot=validateSnapshot(body.snapshot);
    const remote=await readRemote(env);
    if(remote.snapshot&&canonical(validateSnapshot(remote.snapshot))===canonical(snapshot)) return json({ok:true,sha:remote.sha,publishedAt:remote.snapshot.publishedAt,alreadyPublished:true},200,env,origin);
    if(body.expectedSha!==remote.sha) fail(409,'另一台设备已更新云端清单。请先备份本机内容，再读取云端版本。');
    const content={...snapshot,publishedAt:new Date().toISOString(),publishedBy:session.login};
    const result=await github(repoPath(env),env,await installationToken(env),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:'更新旅行清单',content:base64(encoder.encode(JSON.stringify(content,null,2)+'\n')),branch:env.GITHUB_BRANCH,...(remote.sha?{sha:remote.sha}:{})})});
    return json({ok:true,sha:result.content.sha,commit:result.commit.sha,publishedAt:content.publishedAt},200,env,origin);
  } catch(error) { return json({ok:false,message:error.status?error.message:'发布服务暂时不可用，请稍后再试。'},error.status||503,env,origin); }
}
export default {fetch:handle};
