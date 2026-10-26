/*
 * 一次性GitHub App登记助手：浏览器完成注册和仓库选择，密钥仅写到仓库之外的私有目录。
 * 不输出密钥、授权码或会话值；私钥转换为Workers Web Crypto支持的PKCS8格式。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
const worker=process.argv[2];
const directory=process.argv[3];
if(!/^https:\/\/[-a-z0-9.]+\.workers\.dev$/.test(worker||'')||!directory) throw Error('请提供Worker地址与仓库外的密钥目录。');
await fs.mkdir(directory,{recursive:true});
if(process.platform==='win32') {
  const {stdout}=await run('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8'});
  const sid=stdout.match(/S-1-5-[0-9-]+/)?.[0];
  if(!sid) throw Error('无法确认当前用户，未写入密钥。');
  await run('icacls.exe',[directory,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','/grant:r','*S-1-5-18:(OI)(CI)F'],{encoding:'utf8'});
}
const nonce=crypto.randomBytes(32).toString('base64url');
const root='http://127.0.0.1:8173';
const manifest={
  name:'Russia Trip gitdogl '+crypto.randomBytes(3).toString('hex'),
  url:'https://gitdogl.github.io/russia-trip-2026/',
  description:'为旅行清单提供仓库所有者登录与保存发布，只由发布接口访问指定旅行仓库。',
  public:false,
  redirect_url:root+'/manifest/callback',
  callback_urls:[worker+'/auth/callback'],
  setup_url:root+'/installed?nonce='+nonce,
  hook_attributes:{url:worker+'/github/events',active:false},
  default_permissions:{contents:'write'},
  default_events:[],
  request_oauth_on_install:false
};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let created=null;
let busy=false;
async function status(value) { await fs.writeFile(path.join(directory,'setup-status.json'),JSON.stringify(value,null,2),'utf8'); }
const server=http.createServer(async(request,response)=>{
  const url=new URL(request.url,root);
  const page=text=>{response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'});response.end('<!doctype html><meta charset="utf-8"><title>旅行清单发布授权</title><main style="max-width:720px;margin:60px auto;font:17px/1.8 system-ui;padding:20px">'+text+'</main>')};
  try {
    if(url.pathname==='/') {
      if(created) {page('<h1>应用已创建</h1><p>请完成旅行仓库安装授权。</p><a href="'+escape(created.html_url)+'/installations/new">安装到旅行仓库</a>');return;}
      page('<h1>连接GitHub旅行仓库</h1><p>接下来在GitHub注册你的私有发布应用。安装时选择 <b>Only select repositories</b>，只勾选 <b>russia-trip-2026</b>，再点 Install。</p><p>密钥由本机助手接收并保存到仓库外，不会显示在网页或提交到GitHub。</p><form method="post" action="https://github.com/settings/apps/new?state='+nonce+'"><input type="hidden" name="manifest" value="'+escape(JSON.stringify(manifest))+'"><button style="padding:12px 20px;font:inherit" type="submit">前往GitHub创建并授权</button></form>');return;
    }
    if(url.pathname==='/manifest/callback') {
      if(url.searchParams.get('state')!==nonce) throw Error('授权校验未通过，请从本机入口重新操作。');
      if(created) {response.writeHead(302,{Location:created.html_url+'/installations/new'});response.end();return;}
      if(busy) {page('<p>正在完成应用登记，请稍候。</p>');return;}
      busy=true;
      const code=url.searchParams.get('code');
      if(!code||!/^[-a-zA-Z0-9_]+$/.test(code)) throw Error('未收到有效的应用登记结果。');
      const result=await fetch('https://api.github.com/app-manifests/'+code+'/conversions',{method:'POST',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'RussiaTripPublisherSetup'}});
      if(!result.ok) throw Error('GitHub应用登记交换未完成，请重新发起。');
      const app=await result.json();
      if(!app.client_id||!app.client_secret||!app.pem||!/^https:\/\/github\.com\/apps\//.test(app.html_url||'')) throw Error('GitHub未返回完整应用配置。');
      const secrets={GITHUB_CLIENT_ID:app.client_id,GITHUB_CLIENT_SECRET:app.client_secret,GITHUB_PRIVATE_KEY:crypto.createPrivateKey(app.pem).export({type:'pkcs8',format:'pem'}),SESSION_SECRET:crypto.randomBytes(32).toString('base64url')};
      await fs.writeFile(path.join(directory,'worker-secrets.json'),JSON.stringify(secrets,null,2),{encoding:'utf8',mode:0o600});
      created={html_url:app.html_url,id:app.id};
      await status({stage:'app-created',appUrl:app.html_url,worker});
      console.log('GitHub私有应用已创建，密钥已保存到仓库外，等待安装旅行仓库。');
      response.writeHead(302,{Location:app.html_url+'/installations/new','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});response.end();return;
    }
    if(url.pathname==='/installed') {
      if(url.searchParams.get('nonce')!==nonce||!/^\d+$/.test(url.searchParams.get('installation_id')||'')) throw Error('未收到有效仓库安装结果。');
      await status({stage:'installed',appUrl:created?.html_url,worker,installationId:url.searchParams.get('installation_id')});
      console.log('旅行仓库安装已完成，可以继续配置云端发布服务。');
      page('<h1>GitHub授权已完成</h1><p>可以返回Codex。正在接入发布接口，不需要复制任何密钥。</p>');return;
    }
    response.writeHead(404);response.end();
  } catch(error) {
    busy=false;
    response.writeHead(400,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});response.end(error.message);
    console.log('授权流程未完成：'+error.message);
  }
});
server.listen(8173,'127.0.0.1',()=>console.log('本机授权入口已就绪：http://127.0.0.1:8173'));
