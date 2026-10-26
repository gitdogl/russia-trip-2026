/*
 * 跨设备发布：本机编辑继续使用原存储格式，显式“保存并发布”才写GitHub。
 * 云端基线另行缓存；存在本机修改时保留旧基线，避免静默覆盖或重复新增。
 * 浏览器只保存短期发布会话，不接收GitHub App私钥或GitHub访问令牌。
 */
window.tripPublisher = (() => {
  'use strict';
  const stateKey='russia-trip-editor-v1', baseKey='russia-trip-cloud-base-v1', sessionKey='russia-trip-publish-session-v1';
  const pendingKey='russia-trip-publish-after-login';
  const keys=['days','tickets','transportCosts','groundCosts','hotels','packingGroups','packingItems','activities','specialItems'];
  let config=null, base=null, editor=null, busy=false;
  const $=id=>document.getElementById(id);
  function read(key,fallback=null,storage=localStorage) { try{return JSON.parse(storage.getItem(key))??fallback;}catch{return fallback;} }
  function status(text) { $('cloud-status').textContent=text; }
  function valid(snapshot) { return snapshot?.format==='russia-trip-checklists'&&snapshot.version===1&&keys.every(key=>Array.isArray(snapshot.collections?.[key])); }
  function session() { try{return sessionStorage.getItem(sessionKey)||'';}catch{return '';} }
  const hash=location.hash.slice(1).split('&');
  const auth=new URLSearchParams(hash.slice(1).join('&')).get('publish_session');
  if(auth) {
    try{sessionStorage.setItem(sessionKey,auth);}catch{}
    history.replaceState(null,'',location.pathname+location.search+'#'+(['travel','packing','routes','special'].includes(hash[0])?hash[0]:'packing'));
  }
  function dirty(reference) {
    let raw;
    try{raw=localStorage.getItem(stateKey);}catch{return true;}
    if(!raw) return Object.values(read('russia-packing-2027-v1',{})||{}).some(value=>value===true);
    let data;try{data=JSON.parse(raw);}catch{return true;}
    if(!data||data.version!==1) return true;
    if(keys.some(key=>(data.additions?.[key]?.length||0)||(data.deletions?.[key]?.length||0)||Object.values(data.changes?.[key]||{}).some(patch=>Object.keys(patch).length))) return true;
    return Object.entries(data.checked||{}).some(([id,value])=>(value===true)!==(reference?.snapshot?.checked?.[id]===true));
  }
  function storeBase(next,reset) {
    const oldBase=localStorage.getItem(baseKey),oldState=localStorage.getItem(stateKey);
    try{
      localStorage.setItem(baseKey,JSON.stringify(next));
      if(reset) localStorage.setItem(stateKey,JSON.stringify({version:1,changes:{},additions:{},deletions:{},checked:next.snapshot.checked||{}}));
    }catch(error){
      try{if(oldBase===null)localStorage.removeItem(baseKey);else localStorage.setItem(baseKey,oldBase);if(oldState===null)localStorage.removeItem(stateKey);else localStorage.setItem(stateKey,oldState);}catch{}
      throw Error('浏览器未能保存云端基线，请先导出本机备份。');
    }
    base=next;
  }
  async function request(path,options={}) {
    const response=await fetch(config.apiBase+path,{...options,headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers},signal:AbortSignal.timeout(25000)});
    let value;try{value=await response.json();}catch{throw Error('发布接口未返回有效结果，请稍后重试。');}
    if(!response.ok) throw Object.assign(new Error(value.message||'云端请求未完成。'),{status:response.status});
    return value;
  }
  async function latest() {
    const value=await request('/snapshot');
    if(!valid(value.snapshot)) throw Error('云端清单尚未准备好。');
    return value;
  }
  function configureButtons() {
    const enabled=!!config?.enabled&&!!editor;
    $('publish-cloud').disabled=!enabled||busy;
    $('pull-cloud').disabled=!enabled||busy;
    $('login-cloud').disabled=!enabled||busy;
    $('logout-cloud').hidden=!session();
    $('login-cloud').textContent=session()?'重新登录GitHub':'登录GitHub';
  }
  function login(publishAfter=false) {
    if(!config?.enabled) return;
    if(publishAfter) sessionStorage.setItem(pendingKey,'true');else sessionStorage.removeItem(pendingKey);
    const tab=location.hash.slice(1).split('&')[0];
    location.assign(config.apiBase+'/auth/start?tab='+encodeURIComponent(tab||'packing'));
  }
  async function loadBase(fallback) {
    const cached=read(baseKey);
    let initial={sha:null,snapshot:fallback};
    try{
      const response=await fetch('publisher-config.json',{cache:'no-store',signal:AbortSignal.timeout(7000)});
      config=await response.json();
      if(!config.enabled||!/^https:\/\/[-a-z0-9.]+\.workers\.dev$/.test(config.apiBase)) {config=null;throw Error('未启用发布接口。');}
      initial.sha=config.initialSha||null;
      base=valid(cached?.snapshot)?cached:initial;
      const hasChanges=dirty(base);
      let remote=null;
      try{remote=await latest();}catch(error){status('暂时无法连接云端，已保留本机清单。需要联网后再发布。');}
      if(hasChanges) {
        storeBase(base,false);
        if(remote&&remote.sha!==base.sha) status('云端已有新版本，本机修改已保留。请先备份本机内容，再按需读取云端版本。');
        else if(remote) status(session()?'已登录，可保存并发布本机修改。':'本机修改已保留，发布时需登录GitHub。');
      }else if(remote){storeBase(remote,true);status(session()?'已读取云端清单，可点击保存并发布。':'已读取云端清单；编辑后可登录GitHub并发布。');}
      else storeBase(base,false);
    }catch(error){
      base=valid(cached?.snapshot)?cached:initial;
      status(config?'云端连接未完成，保留本机内容。':'发布服务尚未配置，本机保存与备份可继续使用。');
    }
    return base;
  }
  async function publish() {
    if(busy||!editor||!config?.enabled) return;
    let remoteCommitted=false;
    try{
      const snapshot=editor.prepareSnapshot();
      if(!session()) {login(true);return;}
      const submittedState=localStorage.getItem(stateKey);
      busy=true;editor.setPublishing(true);configureButtons();status('正在提交到GitHub，请稍候。');
      const result=await request('/publish',{method:'POST',headers:{Authorization:'Bearer '+session()},body:JSON.stringify({expectedSha:base.sha,snapshot})});
      remoteCommitted=true;
      if(localStorage.getItem(stateKey)!==submittedState) throw Error('GitHub已收到本次清单，但其他页签又修改了本机内容；新修改已保留，请先导出备份再读取云端版本。');
      storeBase({sha:result.sha,snapshot:{...snapshot,publishedAt:result.publishedAt||new Date().toISOString()}},true);
      sessionStorage.removeItem(pendingKey);
      status(result.alreadyPublished?'云端内容一致，正在载入。':'已提交到GitHub，正在载入云端版本。');
      location.reload();
    }catch(error){
      if(remoteCommitted) status('已提交GitHub，但本机同步未完成：'+error.message);
      else if(error.status===401){sessionStorage.removeItem(sessionKey);status('GitHub登录已过期，本机内容仍保留。请重新登录后发布。');}
      else status(error.status===409?error.message:'发布未完成，本机已保存内容保留。'+error.message);
    }finally{busy=false;editor?.setPublishing(false);configureButtons();}
  }
  async function pull() {
    if(busy||!editor) return;
    try{
      if(editor.hasDrafts()) throw Error('请先保存或取消表格中正在编辑的行。');
      busy=true;editor.setPublishing(true);configureButtons();
      const remote=await latest();
      if(dirty(base)&&!confirm('读取云端会替换本机已保存的修改。请先导出备份，确定读取云端版本吗？')) return;
      storeBase(remote,true);location.reload();
    }catch(error){status('读取未完成：'+error.message);}
    finally{busy=false;editor?.setPublishing(false);configureButtons();}
  }
  function attachEditor(value) {
    editor=value;configureButtons();
    if(session()&&sessionStorage.getItem(pendingKey)==='true') setTimeout(publish,0);
  }
  $('publish-cloud').addEventListener('click',publish);
  $('pull-cloud').addEventListener('click',pull);
  $('login-cloud').addEventListener('click',()=>{try{editor?.prepareSnapshot();login(false);}catch(error){status(error.message);}});
  $('logout-cloud').addEventListener('click',()=>{sessionStorage.removeItem(sessionKey);sessionStorage.removeItem(pendingKey);configureButtons();status('已退出发布登录，本机内容仍保留。');});
  return {loadBase,attachEditor};
})();
