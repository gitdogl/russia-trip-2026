/*
 * 四个页签共用清单编辑器：条目与分类可增删改，本机保存，删除可撤销。
 * 只保存相对发布数据的改动，保留既有物品勾选，导出/导入完整备份。
 * 费用按订单记录，人民币和卢布分别重算；空金额保持空白。
 */
(() => {
  'use strict';
  const trip = JSON.parse(document.getElementById('trip-data').textContent);
  const storageKey = 'russia-trip-editor-v1';
  const oldPackingKey = 'russia-packing-2027-v1';
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const clone = value => JSON.parse(JSON.stringify(value));
  const field = (key, label, type = 'text', required = false, options = []) => ({key, label, type, required, options});
  const status = () => field('status', '状态', 'select', false, ['未确认','待订','已确定','已出票','已预订','已取消']);
  const moneyFields = () => [field('currency','币种','select',false,['CNY','RUB']),field('budget','预算金额','money'),field('actual','实际总额','money'),field('paid','已付金额','money')];
  const schemas = {
    days: {label:'每日行程', fields:[field('date','日期','text',true),field('city','城市 / 路段','text',true),field('plan','行程安排','textarea'),field('note','备注','textarea'),field('stay','住宿计划')]},
    tickets: {label:'机票或火车票', fields:[field('window','计划日期'),field('route','路段','text',true),field('mode','交通方式'),status(),field('number','航班 / 车次'),field('from','出发机场 / 车站'),field('to','到达机场 / 车站'),field('departure','票面出发（当地时间）'),field('arrival','票面到达（当地时间）'),field('price','航段票价说明'),field('note','备注','textarea')]},
    transportCosts: {label:'跨城交通费用', fields:[field('window','计划日期'),field('item','费用项目','text',true),status(),...moneyFields(),field('note','备注','textarea')]},
    groundCosts: {label:'接驳或市内路费', fields:[field('window','计划日期'),field('item','费用项目','text',true),field('mode','交通方式'),status(),...moneyFields(),field('note','备注','textarea')]},
    hotels: {label:'住宿', fields:[field('city','城市 / 停留段','text',true),field('nights','住宿计划'),field('plannedNights','计划晚数'),status(),field('name','酒店名称'),field('roomType','房型'),field('checkIn','实际入住日期'),field('checkOut','实际离店日期'),field('rooms','间数','integer'),...moneyFields(),field('note','备注','textarea')]},
    packingGroups: {label:'物品分类', fields:[field('title','分类名称','text',true),field('description','分类说明','textarea')]},
    packingItems: {label:'携带物品', fields:[field('groupId','所属分类','group',true),field('name','物品名称','text',true),field('quantity','数量（例如：2件）'),field('model','型号 / 规格'),field('tag','提示标签'),field('note','物品说明','textarea')]},
    activities: {label:'游玩或吃饭路线', fields:[field('name','名称','text',true),field('kind','类型','select',false,['游玩','吃饭','交通','其他']),field('date','日期'),field('time','时间'),field('city','城市'),field('address','地点 / 地址'),field('route','路线 / 前后衔接','textarea'),field('note','备注','textarea'),field('link','参考链接','url')]},
    specialItems: {label:'特殊事项', fields:[field('name','事项名称','text',true),field('phase','办理阶段','select',false,['出发前','抵达后','旅行中','返程前']),field('status','办理状态','select',false,['待办','进行中','已完成','不适用']),field('deadline','计划时间 / 截止日期'),field('note','办理步骤 / 备注','textarea'),field('link','参考链接','url')]}
  };
  const keys = Object.keys(schemas);
  const extraFields = ['basis','sources'];
  const emptyState = () => ({version:1, changes:{}, additions:{}, deletions:{}, checked:{}});
  let state = emptyState();
  let undoState = null;
  let brokenStorage = '';
  let editor = null;
  let pendingImport = null;

  function normalize(key, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('清单项格式不正确。');
    if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.id) || ['__proto__','constructor','prototype'].includes(value.id)) throw Error('清单项标识不正确。');
    const row = {id:value.id};
    schemas[key].fields.forEach(f => {
      const text = value[f.key] == null ? '' : String(value[f.key]);
      if (text.length > 20000) throw Error(f.label + '内容过长。');
      row[f.key] = text;
    });
    if (key === 'packingItems') {
      row.basis = ['verified','suggestion','video','user'].includes(value.basis) ? value.basis : 'user';
      row.sources = Array.isArray(value.sources) ? value.sources.filter(id => trip.packing.sources.some(source => source.id === id)) : [];
    }
    return row;
  }
  const rawDefaults = Object.fromEntries(['days','tickets','transportCosts','groundCosts','hotels','activities','specialItems'].map(key => [key, trip[key] || []]));
  rawDefaults.packingGroups = trip.packing.groups.map(({id,title,description}) => ({id,title,description}));
  rawDefaults.packingItems = trip.packing.groups.flatMap(group => group.items.map(item => ({...item, groupId:group.id})));
  const defaults = Object.fromEntries(keys.map(key => [key, rawDefaults[key].map(row => normalize(key,row))]));

  // 默认内容与本机改动按稳定ID合并，网站更新不会覆盖已经编辑的字段。
  function rows(key, value = state) {
    const removed = value.deletions[key] || [];
    const result = defaults[key].filter(row => !removed.includes(row.id)).map(row => normalize(key,{...row,...(value.changes[key]?.[row.id] || {}),id:row.id}))
      .concat((value.additions[key] || []).filter(row => !removed.includes(row.id)).map(row => normalize(key,row)));
    // 已删除的分类在发布内容更新后仍保持删除，其下后来新增的默认物品也不重新出现。
    return key==='packingItems' ? result.filter(row=>!(value.deletions.packingGroups || []).includes(row.groupId)) : result;
  }
  function validateCollections(collections) {
    keys.forEach(key => {
      if (!Array.isArray(collections[key]) || collections[key].length > 5000) throw Error('备份缺少清单或条目过多：' + schemas[key].label);
      const ids = new Set();
      collections[key].forEach(row => {
        if (ids.has(row.id)) throw Error('存在重复的清单项标识。');
        ids.add(row.id);
        schemas[key].fields.forEach(f => {
          const text = row[f.key];
          if (f.required && !text.trim()) throw Error('请填写' + f.label + '。');
          if (text && f.type === 'money' && (!/^\d+(\.\d{1,2})?$/.test(text) || !Number.isFinite(Number(text)))) throw Error(f.label + '须为非负金额，最多两位小数。');
          if (text && f.type === 'integer' && !/^[1-9]\d*$/.test(text)) throw Error(f.label + '须为正整数。');
          if (text && f.type === 'url' && !/^https?:\/\//i.test(text)) throw Error('参考链接请使用 http 或 https 地址。');
        });
        if (['transportCosts','groundCosts','hotels'].includes(key) && ['budget','actual','paid'].some(f => row[f] !== '') && !['CNY','RUB'].includes(row.currency)) throw Error('填写费用时请选择币种。');
      });
    });
    const groups = new Set(collections.packingGroups.map(group => group.id));
    if (collections.packingItems.some(item => !groups.has(item.groupId))) throw Error('物品所属分类不存在。');
  }
  function collections(value = state) { return Object.fromEntries(keys.map(key => [key, rows(key,value)])); }
  function readState(raw) {
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || !value.changes || !value.additions || !value.deletions || !value.checked) throw Error('本机数据格式不正确。');
    keys.forEach(key => {
      if (value.additions[key] && !Array.isArray(value.additions[key])) throw Error('本机新增数据格式不正确。');
      if (value.deletions[key] && !Array.isArray(value.deletions[key])) throw Error('本机删除记录格式不正确。');
    });
    validateCollections(collections(value));
    return value;
  }
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try { state = readState(saved); } catch (error) { brokenStorage = saved; }
    } else {
      const old = JSON.parse(localStorage.getItem(oldPackingKey) || '{}');
      defaults.packingItems.forEach(item => { if (old?.[item.id] === true) state.checked[item.id] = true; });
    }
  } catch (error) { /* 存储不可用时仍可读取发布内容，保存时显示实际错误。 */ }

  function announce(message) {
    $('editor-status').textContent = message;
    $('change-notice').hidden = !message;
    $('undo-notice').hidden = !undoState;
  }
  function commit(next, message, allowBroken = false) {
    if (brokenStorage && !allowBroken) throw Error('本机数据读取异常。请先导出原始备份，再导入有效备份。');
    validateCollections(collections(next));
    next.updatedAt = new Date().toISOString();
    try { localStorage.setItem(storageKey,JSON.stringify(next)); }
    catch (error) { throw Error('浏览器未能保存修改，请检查存储空间或浏览器权限。当前内容尚未改动。'); }
    undoState = clone(state);
    state = next;
    brokenStorage = '';
    render();
    $('undo-change').hidden = false;
    announce(message);
  }
  function titleOf(row) { return row.title || row.name || row.item || row.route || row.city || row.date || '该条目'; }
  function actions(key,row) {
    return '<div class="row-actions"><button type="button" class="small-btn" data-edit="'+key+'" data-id="'+esc(row.id)+'" aria-label="编辑 '+esc(titleOf(row))+'">编辑</button><button type="button" class="small-btn delete-btn" data-delete="'+key+'" data-id="'+esc(row.id)+'" aria-label="删除 '+esc(titleOf(row))+'">删除</button></div>';
  }
  function cells(values) { return values.map(value => '<td>'+esc(value)+'</td>').join(''); }
  function badge(status) { return status ? '<span class="label '+(['已出票','已确定','已预订','已完成'].includes(status)?'booked':'pending')+'">'+esc(status)+'</span>' : ''; }
  function emptyRow(count) { return '<tr><td colspan="'+count+'" class="source-note">暂无条目，可点击上方按钮新建。</td></tr>'; }
  function costTable(key,withMode) {
    const fields = ['window','item',...(withMode?['mode']:[]),'status','currency','budget','actual','paid','note'];
    const headings = ['计划日期','费用项目',...(withMode?['交通方式']:[]),'状态','币种','预算金额','实际总额','已付金额','备注','操作'];
    return '<table class="cost-table"><thead><tr>'+headings.map(label=>'<th scope="col">'+label+'</th>').join('')+'</tr></thead><tbody>'+(rows(key).map(row=>'<tr>'+cells(fields.map(f=>row[f]))+'<td>'+actions(key,row)+'</td></tr>').join('') || emptyRow(headings.length))+'</tbody></table>';
  }
  function amount(value) { return value === '' || value == null ? null : Number(value); }
  function subtotal(items,key) {
    const values = items.map(item=>amount(item[key])).filter(value=>value !== null && Number.isFinite(value));
    return values.length ? (values.reduce((sum,value)=>sum+Math.round(value*100),0)/100).toFixed(2) : '';
  }
  function expenseRows() {
    return [['transportCosts','机票与跨城交通'],['groundCosts','接驳与市内路费'],['hotels','住宿']].flatMap(([key,category])=>rows(key).map(row=>({...row,category})));
  }
  function summaryTable(currency,expenses) {
    const items = expenses.filter(item=>item.currency===currency);
    const row = (label,values)=>'<tr>'+cells([label,...['budget','actual','paid'].map(key=>subtotal(values,key))])+'</tr>';
    return '<table class="summary-table"><thead><tr><th>类别</th><th>预算</th><th>实际总额</th><th>已付</th></tr></thead><tbody>'+['机票与跨城交通','接驳与市内路费','住宿'].map(category=>row(category,items.filter(item=>item.category===category))).join('')+'</tbody><tfoot>'+row('已填小计',items)+'</tfoot></table>';
  }
  function renderTravel() {
    const tickets = rows('tickets');
    const booked = tickets.filter(row=>row.status==='已出票').length;
    const pending = tickets.filter(row=>row.status==='待订').length;
    $('hero-ticket-status').textContent = '已出票 '+booked+' 段';
    $('hero-pending-status').textContent = '待订 '+pending+' 段';
    $('booking-summary').textContent = '共 '+tickets.length+' 段；已出票 '+booked+' 段；待订 '+pending+' 段。';
    $('date-note').textContent = trip.dateNote;
    $('itinerary-rows').innerHTML = rows('days').map(row=>'<tr>'+cells([row.date,row.city,[row.plan,row.note].filter(Boolean).join(' '),row.stay])+'<td>'+actions('days',row)+'</td></tr>').join('') || emptyRow(5);
    $('ticket-rows').innerHTML = tickets.map(row=>'<tr>'+cells([row.window,row.route,row.mode])+'<td>'+badge(row.status)+'</td>'+cells([row.number,row.from,row.to,row.departure,row.arrival,row.price,row.note])+'<td>'+actions('tickets',row)+'</td></tr>').join('') || emptyRow(12);
    $('transport-costs').innerHTML = costTable('transportCosts',false);
    $('ground-costs').innerHTML = costTable('groundCosts',true);
    const hotelFields = schemas.hotels.fields.filter(f=>!['city','nights','plannedNights','status','note'].includes(f.key));
    $('hotels').innerHTML = rows('hotels').map(row=>'<article class="card hotel-card"><div class="hotel-heading"><h3>'+esc(row.city)+'</h3>'+badge(row.status)+'</div><p>'+esc(row.nights)+'</p><p class="muted">计划晚数：'+esc(row.plannedNights)+'</p><p class="hotel-note">'+esc(row.note)+'</p><dl class="detail-grid">'+hotelFields.map(f=>'<div><dt>'+f.label+'</dt><dd>'+esc(row[f.key])+'</dd></div>').join('')+'</dl>'+actions('hotels',row)+'</article>').join('') || '<p class="source-note">暂无住宿，可点击上方按钮新建。</p>';
    const expenses = expenseRows();
    const recorded = expenses.filter(row=>['budget','actual','paid'].some(key=>row[key] !== '')).length;
    $('amount-status').textContent = '已有金额 '+recorded+' / '+expenses.length+' 项。';
    const airfare = subtotal(rows('transportCosts').filter(row=>row.status==='已出票'&&row.currency==='CNY'),'actual');
    $('known-cost').textContent = airfare ? '已出票交通费用 ¥'+Number(airfare).toLocaleString('zh-CN') : '交通金额待补充';
    $('expense-summary').innerHTML = [['CNY','人民币'],['RUB','俄罗斯卢布']].map(([currency,label])=>'<article class="card"><h3>'+label+' · '+currency+'</h3><div class="table-scroll" role="region" aria-label="'+label+'费用汇总，可左右滑动" tabindex="0">'+summaryTable(currency,expenses)+'</div></article>').join('');
  }
  function sourceLink(id) {
    const source = trip.packing.sources.find(row=>row.id===id);
    return source ? '<a class="packing-reference" href="'+esc(source.url)+'" target="_blank" rel="noopener noreferrer">'+esc(source.title)+'</a>' : '';
  }
  function renderPacking() {
    const groups = rows('packingGroups');
    const items = rows('packingItems');
    const labels = {verified:'资料支持',suggestion:'通用建议',video:'视频线索',user:'自行填写'};
    $('packing-categories').innerHTML = groups.map(group=>'<button type="button" data-packing-scroll="'+esc(group.id)+'">'+esc(group.title)+'</button>').join('');
    $('packing-groups').innerHTML = groups.map(group=>{
      const list = items.filter(item=>item.groupId===group.id);
      return '<article class="card packing-card" id="packing-'+esc(group.id)+'"><div class="packing-card-head"><h3>'+esc(group.title)+'</h3><span>'+list.filter(item=>state.checked[item.id]===true).length+' / '+list.length+'</span></div><p class="source-note">'+esc(group.description)+'</p><div class="row-actions"><button type="button" class="small-btn" data-create="packingItems" data-group="'+esc(group.id)+'">新增物品</button>'+actions('packingGroups',group)+'</div><ul class="packing-items">'+list.map(item=>'<li class="packing-item"><input type="checkbox" id="pack-'+esc(item.id)+'" data-packing-item="'+esc(item.id)+'"'+(state.checked[item.id]===true?' checked':'')+'><div><label for="pack-'+esc(item.id)+'">'+esc(item.name)+'</label><p>'+esc(item.note)+'</p>'+((item.quantity||item.model)?'<p class="packing-spec">'+esc([item.quantity?'数量：'+item.quantity:'',item.model?'型号：'+item.model:''].filter(Boolean).join(' · '))+'</p>':'')+'<div class="packing-meta"><span class="packing-tag '+esc(item.basis)+'">'+esc(labels[item.basis])+'</span>'+(item.tag?'<span class="packing-tag">'+esc(item.tag)+'</span>':'')+item.sources.map(sourceLink).join('')+'</div>'+actions('packingItems',item)+'</div></li>').join('')+'</ul></article>';
    }).join('') || '<p class="source-note">暂无分类，可先新建物品分类。</p>';
    const checked = items.filter(item=>state.checked[item.id]===true).length;
    $('packing-progress-text').textContent = '已勾选 '+checked+' / '+items.length+' 项';
    $('packing-progress').max = Math.max(items.length,1);
    $('packing-progress').value = checked;
  }
  function safeLink(url) { return /^https?:\/\//i.test(url) ? '<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">打开参考链接</a>' : ''; }
  function renderCustom(key,target) {
    $(target).innerHTML = rows(key).map(row=>'<article class="card editable-card"><div class="hotel-heading"><h3>'+esc(row.name)+'</h3>'+badge(row.status || row.kind)+'</div><dl class="detail-grid">'+schemas[key].fields.filter(f=>!['name','link','status','kind'].includes(f.key)).map(f=>'<div><dt>'+f.label+'</dt><dd>'+esc(row[f.key])+'</dd></div>').join('')+'</dl><p>'+safeLink(row.link)+'</p>'+actions(key,row)+'</article>').join('');
  }
  function render() { renderTravel(); renderPacking(); renderCustom('activities','activity-items'); renderCustom('specialItems','special-items'); }

  // 编辑框按清单类型展示字段，保存前验证；编辑来源内容后改为“自行填写”。
  function openEditor(key,id='',groupId='') {
    const row = id ? rows(key).find(value=>value.id===id) : {};
    if (!row) return;
    if (key==='packingItems' && !rows('packingGroups').length) { announce('请先新建物品分类。'); return; }
    editor = {key,id};
    pendingImport = null;
    $('editor-title').textContent = (id?'编辑':'新建')+schemas[key].label;
    $('editor-error').textContent = '';
    $('editor-submit').textContent = '保存';
    $('editor-fields').innerHTML = schemas[key].fields.map(f=>{
      let value = row[f.key] || (f.key==='groupId'?groupId:'');
      const common = ' name="'+f.key+'" id="edit-'+f.key+'" aria-label="'+esc(f.label)+'"'+(f.required?' required':'');
      let control;
      if (f.type==='textarea') control='<textarea'+common+' rows="3">'+esc(value)+'</textarea>';
      else if (['select','group'].includes(f.type)) {
        const options = f.type==='group' ? rows('packingGroups').map(group=>[group.id,group.title]) : f.options.map(option=>[option,option]);
        if (value && !options.some(([id])=>id===value)) options.push([value,value]);
        control='<select'+common+'><option value="">请选择</option>'+options.map(([id,label])=>'<option value="'+esc(id)+'"'+(id===value?' selected':'')+'>'+esc(label)+'</option>').join('')+'</select>';
      } else control='<input'+common+' type="'+(['money','integer'].includes(f.type)?'number':f.type==='url'?'url':'text')+'" value="'+esc(value)+'"'+(['money','integer'].includes(f.type)?' min="0" step="'+(f.type==='money'?'0.01':'1')+'"':'')+'>';
      return '<label class="editor-field '+(f.type==='textarea'?'wide':'')+'" for="edit-'+f.key+'"><span>'+f.label+(f.required?' *':'')+'</span>'+control+'</label>';
    }).join('');
    $('item-editor').showModal();
  }
  function setRecord(next,key,row) {
    const base = defaults[key].find(value=>value.id===row.id);
    if (!base) {
      const added = next.additions[key] || [];
      const index = added.findIndex(value=>value.id===row.id);
      if (index < 0) added.push(row); else added[index]=row;
      next.additions[key] = added;
    } else {
      next.changes[key] ||= {};
      const patch = {};
      [...schemas[key].fields.map(f=>f.key),...(key==='packingItems'?extraFields:[])].forEach(field=>{ if (JSON.stringify(row[field])!==JSON.stringify(base[field])) patch[field]=clone(row[field]); });
      next.changes[key][row.id] = patch;
    }
  }
  function removeRecord(next,key,id) {
    next.additions[key] = (next.additions[key] || []).filter(row=>row.id!==id);
    if (defaults[key].some(row=>row.id===id)) next.deletions[key] = [...new Set([...(next.deletions[key] || []),id])];
    if (next.changes[key]) delete next.changes[key][id];
    if (key==='packingItems') delete next.checked[id];
  }
  function deleteRecord(key,id) {
    const row = rows(key).find(value=>value.id===id);
    if (!row) return;
    const next = clone(state);
    let extra = '';
    if (key==='packingGroups') {
      const items = rows('packingItems').filter(item=>item.groupId===id);
      items.forEach(item=>removeRecord(next,'packingItems',item.id));
      extra = '及其中 '+items.length+' 项物品';
    }
    removeRecord(next,key,id);
    commit(next,'已删除“'+titleOf(row)+'”'+extra+'，可点击撤销。');
  }
  $('editor-form').addEventListener('submit',event=>{
    event.preventDefault();
    try {
      if (pendingImport) { commit(pendingImport,'备份已导入，可撤销本次导入。',true); pendingImport=null; $('item-editor').close(); return; }
      const {key,id} = editor;
      const old = id ? rows(key).find(row=>row.id===id) : {};
      const values = Object.fromEntries(new FormData(event.target));
      const row = normalize(key,{...old,...values,id:id || 'user-'+crypto.randomUUID()});
      if (key==='packingItems' && (!id || row.name!==old.name || row.note!==old.note)) { row.basis='user'; row.sources=[]; }
      const next = clone(state);
      setRecord(next,key,row);
      commit(next,(id?'已更新':'已新建')+'“'+titleOf(row)+'”。');
      $('item-editor').close();
    } catch (error) { $('editor-error').textContent=error.message; }
  });
  $('editor-cancel').addEventListener('click',()=>$('item-editor').close());
  $('item-editor').addEventListener('close',()=>{ editor=null; pendingImport=null; });
  document.addEventListener('click',event=>{
    const button = event.target.closest('button');
    if (!button) return;
    try {
      if (button.dataset.create) openEditor(button.dataset.create,'',button.dataset.group || '');
      if (button.dataset.edit) openEditor(button.dataset.edit,button.dataset.id);
      if (button.dataset.delete) deleteRecord(button.dataset.delete,button.dataset.id);
      if (button.dataset.packingScroll) $('packing-'+button.dataset.packingScroll).scrollIntoView({behavior:'smooth',block:'start'});
    } catch (error) { announce(error.message); }
  });
  $('packing-groups').addEventListener('change',event=>{
    const input = event.target.closest('input[data-packing-item]');
    if (!input) return;
    try { const next=clone(state); next.checked[input.dataset.packingItem]=input.checked; commit(next,'物品勾选已保存。'); }
    catch (error) { input.checked=state.checked[input.dataset.packingItem]===true; announce(error.message); }
  });
  $('undo-change').addEventListener('click',()=>{
    if (!undoState) return;
    try {
      const previous=clone(undoState);
      commit(previous,'已撤销上一次修改。');
      undoState=null;
      $('undo-change').hidden=true;
      $('undo-notice').hidden=true;
    } catch (error) { announce(error.message); }
  });
  $('undo-notice').addEventListener('click',()=>$('undo-change').click());
  $('dismiss-notice').addEventListener('click',()=>{ $('change-notice').hidden=true; });

  // 备份包含当前完整清单和勾选值；导入先核对格式与条目数，再由用户确认替换。
  function downloadFile(name,content,type) {
    const url=URL.createObjectURL(new Blob([content],{type}));
    const link=document.createElement('a'); link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  $('export-backup').addEventListener('click',()=>{
    if (brokenStorage) { downloadFile('清单原始数据备份.txt',brokenStorage,'text/plain;charset=utf-8'); return; }
    const backup={format:'russia-trip-checklists',version:1,exportedAt:new Date().toISOString(),collections:collections(),checked:state.checked};
    downloadFile('俄罗斯旅行清单备份.json',JSON.stringify(backup,null,2),'application/json;charset=utf-8');
    announce('已导出当前清单备份。');
  });
  $('import-backup').addEventListener('click',()=>$('backup-file').click());
  $('backup-file').addEventListener('change',async event=>{
    try {
      const file=event.target.files[0]; if (!file) return;
      if (file.size>2*1024*1024) throw Error('备份文件不能超过2MB。');
      const backup=JSON.parse(await file.text());
      if (backup.format!=='russia-trip-checklists' || backup.version!==1 || !backup.collections) throw Error('请选择本页导出的清单JSON备份。');
      const imported=Object.fromEntries(keys.map(key=>{
        if (!Array.isArray(backup.collections[key])) throw Error('备份缺少清单：'+schemas[key].label);
        return [key,backup.collections[key].map(row=>normalize(key,row))];
      }));
      validateCollections(imported);
      const next=emptyState();
      keys.forEach(key=>{
        const ids=new Set(imported[key].map(row=>row.id));
        next.deletions[key]=defaults[key].filter(row=>!ids.has(row.id)).map(row=>row.id);
        imported[key].forEach(row=>setRecord(next,key,row));
      });
      imported.packingItems.forEach(item=>{ if (backup.checked?.[item.id]===true) next.checked[item.id]=true; });
      pendingImport=next;
      editor=null;
      $('editor-title').textContent='导入清单备份';
      $('editor-error').textContent='';
      $('editor-fields').innerHTML='<p class="wide">导入会替换当前浏览器的清单和勾选状态。建议先导出当前内容；导入后可撤销本次替换。</p><ul class="wide">'+keys.map(key=>'<li>'+schemas[key].label+'：'+imported[key].length+' 项</li>').join('')+'</ul>';
      $('editor-submit').textContent='确认导入并替换';
      $('item-editor').showModal();
    } catch (error) { announce('导入未执行：'+error.message); }
    finally { event.target.value=''; }
  });

  // 下载文档从当前页面数据生成，包含尚未发布到GitHub的本机改动。
  function markdownTable(headers,values) {
    const text=value=>String(value == null ? '' : value).replace(/\|/g,'／').replace(/[\r\n]+/g,'；');
    return '| '+headers.join(' | ')+' |\n| '+headers.map(()=>'---').join(' | ')+' |\n'+values.map(row=>'| '+row.map(text).join(' | ')+' |').join('\n')+'\n\n';
  }
  function exportDocument(name) {
    let text='';
    if (name==='packing') {
      text='# 携带物品清单\n\n';
      rows('packingGroups').forEach(group=>{
        text+='## '+group.title+'\n\n'+group.description+'\n\n';
        rows('packingItems').filter(item=>item.groupId===group.id).forEach(item=>{ text+='- ['+(state.checked[item.id]===true?'x':' ')+'] '+item.name+(item.quantity?'；数量：'+item.quantity:'')+(item.model?'；型号：'+item.model:'')+'：'+item.note+'\n'; });
        text+='\n';
      });
    } else if (schemas[name]) {
      text='# '+schemas[name].label+'清单\n\n'+markdownTable(schemas[name].fields.map(f=>f.label),rows(name).map(row=>schemas[name].fields.map(f=>row[f.key])));
    } else {
      text='# 机火酒行程与费用清单\n\n';
      ['days','tickets','transportCosts','groundCosts','hotels'].forEach(key=>{
        text+='## '+schemas[key].label+'\n\n'+markdownTable(schemas[key].fields.map(f=>f.label),rows(key).map(row=>schemas[key].fields.map(f=>row[f.key])));
      });
      const expenses=expenseRows();
      text+='## 费用已填小计\n\n'+markdownTable(['币种','预算','实际总额','已付金额'],['CNY','RUB'].map(currency=>[currency,...['budget','actual','paid'].map(key=>subtotal(expenses.filter(row=>row.currency===currency),key))]));
    }
    const filename = name==='packing'?'携带物品清单.md':name==='activities'?'游玩与吃饭路线.md':name==='specialItems'?'特殊事项清单.md':'行程与订票清单.md';
    downloadFile(filename,text,'text/markdown;charset=utf-8');
  }
  document.querySelectorAll('[data-download-list]').forEach(link=>link.addEventListener('click',event=>{event.preventDefault();exportDocument(link.dataset.downloadList);}));

  $('packing-note').textContent='可按分类新建、编辑和删除物品，填写数量、型号与说明；勾选表示已核对装包。';
  $('packing-read-scope').textContent=trip.packing.readScope;
  $('packing-videos').innerHTML=trip.packing.videos.map(video=>'<tr><td><a href="'+esc(video.url)+'" target="_blank" rel="noopener noreferrer">'+esc(video.title)+'</a></td>'+cells([video.status,video.finding])+'</tr>').join('');
  $('packing-sources').innerHTML=trip.packing.sources.map(source=>'<li><a href="'+esc(source.url)+'" target="_blank" rel="noopener noreferrer">'+esc(source.title)+'</a><p>'+esc(source.scope)+'</p></li>').join('');
  const tabs=[...document.querySelectorAll('[role="tab"]')];
  function activateTab(name,focus=false) {
    const selected=tabs.find(tab=>tab.dataset.panel===name) || tabs[0];
    tabs.forEach(tab=>{ const active=tab===selected; tab.setAttribute('aria-selected',String(active)); tab.tabIndex=active?0:-1; $(tab.getAttribute('aria-controls')).hidden=!active; });
    if (focus) selected.focus();
  }
  tabs.forEach((tab,index)=>{
    tab.addEventListener('click',()=>{activateTab(tab.dataset.panel);history.replaceState(null,'','#'+tab.dataset.panel);});
    tab.addEventListener('keydown',event=>{
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const target=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
      activateTab(tabs[target].dataset.panel,true); history.replaceState(null,'','#'+tabs[target].dataset.panel);
    });
  });
  window.addEventListener('hashchange',()=>activateTab(location.hash.slice(1)));
  render();
  activateTab(location.hash.slice(1));
  if (brokenStorage) announce('本机数据读取异常，原始内容已保留。请先导出备份，再导入有效备份。');
})();
