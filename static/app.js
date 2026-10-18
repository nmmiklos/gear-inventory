'use strict';
const t=(key,vars)=>I18n.t(key,vars),msg=(key,vars)=>I18n.msg(key,vars);
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const deviceTypes = [];
const statuses = [];
const acquisitionTypes = [];
const labels = {name:'Név',category:'Kategória',brand:'Márka',model:'Modell',serial:'Sorozatszám',status:'Állapot',location:'Lokáció',acquired:'Vásárlás dátuma',price:'Vételár',acquisition_type:'Beszerzés módja',notes:'Jegyzet',parent_id:'Szülő eszköz',parent_name:'Szülő eszköz',event:'Esemény',filename:'Fájlnév',kind:'Típus',happened:'Dátum',title:'Cím',details:'Részletek'};
const actions = {create:'Felvétel',import:'CSV import',update:'Módosítás',bulk_update:'Közös szerkesztés',delete:'Törlés',detach:'Alkatrész leválasztása',event:'Naplóesemény',attachment:'Fájlfeltöltés'};
let items = [], recent = [], selected = new Set(), visible = [], view = 'dashboard', auditCursor = null, toastTimer, modalToken = 0;
async function api(url, method='GET', body) {
  const response = await fetch(url, {method,headers:{'Accept-Language':I18n.language,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  const result = await response.json();
  if (!response.ok) throw Error(I18n.error(result.error || 'A művelet nem sikerült'));
  return result;
}
function notice(message, error=false) {
  clearTimeout(toastTimer); $('#toast').textContent = I18n.error(message.message || message);
  $('#toast').classList.toggle('error',error); $('#toast').classList.remove('hidden');
  toastTimer = setTimeout(()=>$('#toast').classList.add('hidden'),6500);
}
function showLogin() { $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); }
function options(values,current){return values.map(value=>`<option value="${esc(value)}" data-i18n="${esc(value)}" ${value===current?'selected':''}>${esc(t(value))}</option>`).join('');}
function categories() { return [...deviceTypes].sort((a,b)=>t(a).localeCompare(t(b),I18n.language)); }
function dateTime(value) { return I18n.dateTime(value); }
function open(content) { modalToken++; $('#modal').innerHTML='<div class="modal-language">'+I18n.picker()+'</div>'+content;I18n.translate($('#modal')); if(!$('#dialog').open) $('#dialog').showModal(); }
function close() { modalToken++; $('#dialog').close(); }
async function refresh() {
  const [list,log,catalog]=await Promise.all([api('/api/items'),api('/api/audit?limit=8'),api('/api/catalog')]);
  deviceTypes.splice(0,deviceTypes.length,...catalog.categories);statuses.splice(0,statuses.length,...catalog.statuses);acquisitionTypes.splice(0,acquisitionTypes.length,...catalog.acquisition_types);
  $('#acquisitionFilter').innerHTML='<option value="" data-i18n="Minden beszerzés">All acquisition methods</option>'+options(acquisitionTypes,$('#acquisitionFilter').value);
  $('#filter').innerHTML='<option value="" data-i18n="Minden állapot">All statuses</option><option value="__repair" data-i18n="Hibás / javítás alatt">Faulty / under repair</option><option value="__closed" data-i18n="Eladott / elajándékozott">Sold / given away</option>'+options(statuses,$('#filter').value);
  items=list;recent=log.entries;
  selected=new Set([...selected].filter(id=>items.some(item=>item.id===id)));
  const category=$('#categoryFilter').value;
  $('#categoryFilter').innerHTML='<option value="" data-i18n="Minden kategória">All categories</option>'+options([...new Set(items.map(item=>item.category))].sort((a,b)=>t(a).localeCompare(t(b),I18n.language)),category);
  renderDashboard();renderInventory();I18n.translate();
}
async function start() {
  await I18n.ready;GearSort.setLocale(I18n.language);$('#loginLanguage').innerHTML=I18n.picker();$('#appLanguage').innerHTML=I18n.picker();I18n.translate();
  try {await api('/api/me');$('#login').classList.add('hidden');$('#app').classList.remove('hidden');await refresh();}
  catch(err) {showLogin(); if(err.message!==t('Bejelentkezés szükséges')) notice(err,true);}
}
$('#loginForm').onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
  try{await api('/api/login','POST',{password:event.target.password.value});event.target.reset();$('#loginError').textContent='';await start();}
  catch(err){$('#loginError').textContent=I18n.error(err.message);}finally{button.disabled=false;}
};
$('#logout').onclick=async()=>{try{await api('/api/logout','POST');selected.clear();showLogin();}catch(err){notice(err,true);}};
function switchView(next) {
  view=next;
  for(const name of ['dashboard','inventory','audit']) $('#'+name+'View').classList.toggle('hidden',name!==next);
  document.querySelectorAll('[data-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.view===next)));
  if(next==='audit') loadAudit().catch(err=>notice(err,true));
}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>switchView(button.dataset.view));
function applyDashboardFilter(filter={}) {
  $('#search').value='';$('#filter').value=filter.status||'';$('#ownership').value=filter.ownership||'';$('#categoryFilter').value=filter.category||'';$('#acquisitionFilter').value=filter.acquisition_type||'';
  selected.clear();renderInventory();switchView('inventory');
}
function renderDashboard() {
  const summary=GearSort.summary(items);
  const currencyText=Object.entries(summary.totals).map(([currency,amount])=>new Intl.NumberFormat(I18n.locale(),{style:'currency',currency,maximumFractionDigits:2}).format(amount)).join(' · ')||t('Nincs rögzített érték');
  const cards=[
    ['Összes eszköz',items.length,{}],['Tulajdonban lévő',summary.owned, {ownership:'owned'}],
    ['Használatban',summary.inUse,{status:'Használatban'}],['Hibás / javítás alatt',summary.repair,{status:'__repair'}],
    ['Eladott / elajándékozott',summary.closed,{status:'__closed'}],['Tulajdonban lévő összérték',currencyText,{ownership:'owned'}]
  ];
  $('#dashboardStats').innerHTML=cards.map(([label,value],index)=>`<button class="stat" data-stat="${index}"><b>${esc(value)}</b><span>${msg(label)}</span>${index===5?`${summary.unknown>0?`<small>${msg('{n} tételnél nincs értelmezhető ár',{n:summary.unknown})}</small>`:''}${summary.gifts>0?`<small>${msg('{n} tételt kaptam ajándékba',{n:summary.gifts})}</small>`:''}`:''}</button>`).join('');
  document.querySelectorAll('[data-stat]').forEach(button=>button.onclick=()=>applyDashboardFilter(cards[+button.dataset.stat][2]));
  $('#acquisitionBreakdown').innerHTML=acquisitionTypes.map(type=>`<button class="category-row" data-acquisition="${esc(type)}"><span>${msg(type==='Ingyen elvihető'?'Ingyen':type)}</span><strong>${summary.acquisitions[type]||0}</strong></button>`).join('');
  document.querySelectorAll('[data-acquisition]').forEach(button=>button.onclick=()=>applyDashboardFilter({acquisition_type:button.dataset.acquisition,ownership:'owned'}));
  $('#categoryBreakdown').innerHTML=summary.categories.length?summary.categories.map(([category,count])=>`<button class="category-row" data-category="${esc(category)}"><span>${msg(category)}</span><strong>${count}</strong></button>`).join(''):`<p class="muted">${msg("Még nincs eszköz a nyilvántartásban.")}</p>`;
  document.querySelectorAll('[data-category]').forEach(button=>button.onclick=()=>applyDashboardFilter({category:button.dataset.category}));
  $('#recentChanges').innerHTML=recent.length?recent.map(entry=>`<div class="recent-row"><button class="text-button" data-audit-item="${entry.item_id}" ${entry.item_exists?'':'disabled'}>${esc(entry.item_name)}</button><span>${msg(actions[entry.action]||entry.action)}</span><small data-i18n-date="${esc(entry.created_at)}">${esc(dateTime(entry.created_at))}</small></div>`).join(''):`<p class="muted">${msg("A következő módosítások itt is megjelennek.")}</p>`;
  bindItemLinks($('#recentChanges'));
}
$('#allAudit').onclick=()=>switchView('audit');
function renderInventory() {
  const query=$('#search').value.toLocaleLowerCase(I18n.language), status=$('#filter').value,category=$('#categoryFilter').value;
  visible=GearSort.sort(items.filter(item=>
    GearSort.matchesStatus(item,status)&&($('#ownership').value!=='owned'||GearSort.isOwned(item))&&(!category||item.category===category)&&(!$('#acquisitionFilter').value||item.acquisition_type===$('#acquisitionFilter').value)&&
    [item.name,item.brand,item.model,item.serial,item.notes].join(' ').toLocaleLowerCase(I18n.language).includes(query)
  ),$('#sort').value);
  $('#resultCount').innerHTML=msg('{visible} találat / {total} eszköz',{visible:visible.length,total:items.length});
  $('#items').innerHTML=visible.length?visible.map(item=>`<article class="card"><div class="card-top"><label class="check-label"><input type="checkbox" data-select="${item.id}" aria-label="${esc(t('{name} kijelölése',{name:item.name}))}" ${selected.has(item.id)?'checked':''}></label><span class="tag ${GearSort.isOwned(item)?'':'closed'}">${msg(item.status)}</span></div><button class="card-link" data-open="${item.id}"><h3>${esc(item.name)}</h3><p>${esc([item.brand,item.model].filter(Boolean).join(' · ')||t(item.category))}</p></button><div class="foot"><span>${msg(item.category)}</span><span>${esc(item.location||t('Nincs lokáció'))}</span></div>${item.price?`<p class="card-price">${esc(item.price)}</p>`:''}</article>`).join(''):`<div class="empty">${msg("Nincs találat ezekkel a szűrőkkel.")}</div>`;
  document.querySelectorAll('[data-open]').forEach(button=>button.onclick=()=>detail(+button.dataset.open));
  document.querySelectorAll('[data-select]').forEach(input=>input.onchange=()=>{const id=+input.dataset.select;input.checked?selected.add(id):selected.delete(id);renderSelection();});
  renderSelection();
}
function renderSelection() {
  $('#selectedCount').innerHTML=msg('{n} kijelölve',{n:selected.size});
  $('#bulkEdit').disabled=selected.size===0;
  $('#clearSelection').disabled=selected.size===0;
  const checked=visible.filter(item=>selected.has(item.id)).length;
  $('#selectVisible').checked=visible.length>0&&checked===visible.length;
  $('#selectVisible').indeterminate=checked>0&&checked<visible.length;
  $('#selectVisible').disabled=visible.length===0;
}
$('#filter').innerHTML+=options(statuses,'');
$('#search').oninput=renderInventory;
for(const id of ['filter','ownership','categoryFilter','acquisitionFilter','sort']) $('#'+id).onchange=renderInventory;
$('#clearFilters').onclick=()=>{$('#search').value='';for(const id of ['filter','ownership','categoryFilter','acquisitionFilter'])$('#'+id).value='';renderInventory();};
$('#selectVisible').onchange=event=>{visible.forEach(item=>event.target.checked?selected.add(item.id):selected.delete(item.id));renderInventory();};
$('#clearSelection').onclick=()=>{selected.clear();renderInventory();};
const fieldLimits={name:200,brand:100,model:120,serial:120,location:120,acquired:30,price:80,notes:10000};
function fieldControl(field,value,disabled=false) {
  const attr=` aria-label="${esc(t(labels[field]))}" data-i18n-aria-label="${esc(labels[field])}"`+(disabled?' disabled':'');
  if(field==='acquisition_type')return `<select name="acquisition_type"${attr}>${options(acquisitionTypes,value||'Ismeretlen')}</select>`;
  if(field==='status') return `<select name="status"${attr}>${options([...new Set([...statuses,value].filter(Boolean))],value||'Aktív')}</select>`;
  if(field==='category') {
    const types=categories(), known=types.includes(value);
    const placeholder=known?'':`<option value="" selected disabled data-i18n="${value?'Jelenlegi: {value} (korábbi kategória)':'Válassz kategóriát'}" data-i18n-vars="${esc(JSON.stringify({value}))}">${value?esc(t('Jelenlegi: {value} (korábbi kategória)',{value:t(value)})):t('Válassz kategóriát')}</option>`;
    return `<select name="category"${attr}${value?'':' required'}>${placeholder}${options(types,known?value:'')}</select>`;
  }
  if(field==='notes') return `<textarea name="notes" maxlength="10000"${attr}>${esc(value)}</textarea>`;
  return `<input name="${field}" ${field==='acquired'?'type="date"':''} maxlength="${fieldLimits[field]}" value="${esc(value)}"${attr}>`;
}
function edit(item={}) {
  const editing=!!item.id,fields=['name','category','brand','model','serial','status','location','acquired','price','acquisition_type','notes'];
  open(`<h2>${msg(editing?'Eszköz szerkesztése':'Új eszköz')}</h2><p class="sub">${msg("A változások automatikusan bekerülnek az auditnaplóba.")}</p><form id="itemForm"><div class="formgrid">${fields.map(field=>`<label class="${field==='notes'?'wide':''}">${msg(labels[field])}${field==='name'?' *':''}${fieldControl(field,item[field])}</label>`).join('')}<label class="wide">${msg("Része ennek az eszköznek")}<select name="parent_id"><option value="" data-i18n="Önálló eszköz">Standalone item</option>${items.filter(parent=>parent.id!==item.id).map(parent=>`<option value="${parent.id}" ${parent.id===item.parent_id?'selected':''}>${esc(parent.name)}</option>`).join('')}</select></label></div><div class="actions"><button type="button" class="ghost" id="cancel">${msg("Mégse")}</button><button>${msg("Mentés")}</button></div></form>`);
  $('#itemForm [name="name"]').required=true;$('#cancel').onclick=close;
  $('#itemForm').onsubmit=async event=>{
    event.preventDefault();const button=event.target.querySelector('button:not([type="button"])');button.disabled=true;
    try{const data=Object.fromEntries(new FormData(event.target));if(editing&&!data.category)data.category=item.category;const result=await api(editing?`/api/items/${item.id}`:'/api/items',editing?'PUT':'POST',data);close();await refresh();await detail(editing?item.id:result.id);notice(t('Eszköz mentve'));}
    catch(err){notice(err,true);}finally{button.disabled=false;}
  };
}
document.querySelectorAll('.add-item').forEach(button=>button.onclick=()=>edit());
function bulkEdit() {
  const targets=items.filter(item=>selected.has(item.id));
  if(targets.length>500){notice(t('Egyszerre legfeljebb 500 eszköz módosítható'),true);return;}
  const fields=['status','category','location','brand','model','acquired','price','acquisition_type','notes'];
  open(`<h2>${msg("Közös szerkesztés")}</h2><p class="sub">${msg('{n} eszközön csak a bejelölt mezők változnak. Az üres érték törli az adott mező tartalmát.',{n:targets.length})}</p><details class="bulk-targets"><summary>${msg('Kijelölt eszközök ({n})',{n:targets.length})}</summary><ul>${targets.map(item=>`<li>${esc(item.name)}</li>`).join('')}</ul></details><form id="bulkForm"><div class="formgrid">${fields.map(field=>`<div class="bulk-field ${field==='notes'?'wide':''}"><label class="check-label"><input type="checkbox" data-enable="${field}">${msg('{field} módosítása',{field:labels[field]})}</label>${fieldControl(field,'',true)}</div>`).join('')}</div><div class="actions"><button type="button" class="ghost" id="cancel">${msg("Mégse")}</button><button id="bulkSave" disabled>${msg('Alkalmazás {n} eszközre',{n:targets.length})}</button></div></form>`);
  $('#cancel').onclick=close;
  document.querySelectorAll('[data-enable]').forEach(input=>input.onchange=()=>{$(`#bulkForm [name="${input.dataset.enable}"]`).disabled=!input.checked;$('#bulkSave').disabled=!$('#bulkForm input[data-enable]:checked');});
  $('#bulkForm').onsubmit=async event=>{
    event.preventDefault();const changes=Object.fromEntries(new FormData(event.target));
    if(!Object.keys(changes).length)return;
    if(!confirm(t('{n} eszközön módosítod ezeket: {fields}?',{n:targets.length,fields:Object.keys(changes).map(field=>t(labels[field])).join(', ')})))return;
    $('#bulkSave').disabled=true;
    try{const result=await api('/api/items/bulk','POST',{ids:targets.map(item=>item.id),changes});close();selected.clear();await refresh();notice(t('{updated} eszköz módosítva, {unchanged} változatlan',{updated:result.updated,unchanged:result.selected-result.updated}));}
    catch(err){notice(err,true);$('#bulkSave').disabled=false;}
  };
}
$('#bulkEdit').onclick=bulkEdit;
function printable(value) {return value===null||value===''?'∅':typeof value==='object'?JSON.stringify(value):String(value);}
function fieldValue(field,value){if(field==='event'&&value&&typeof value==='object')return Object.entries(value).map(([key,text])=>`<span>${msg(labels[key]||key)}: ${key==='kind'?msg(text):esc(text)}<br></span>`).join('');return ['category','status','acquisition_type'].includes(field)&&value?msg(value):esc(printable(value));}
function auditHTML(entry) {
  return `<article class="audit-entry"><div class="audit-heading"><button class="text-button" data-audit-item="${entry.item_id}" ${entry.item_exists?'':'disabled'}>${esc(entry.item_name)}</button><span class="tag">${msg(actions[entry.action]||entry.action)}</span><time data-i18n-date="${esc(entry.created_at)}">${esc(dateTime(entry.created_at))}</time></div><details><summary>${msg('{n} rögzített mező / esemény',{n:Object.keys(entry.changes).length})}</summary><dl class="changes">${Object.entries(entry.changes).map(([field,change])=>`<div><dt>${msg(labels[field]||field)}</dt><dd><span class="old-value">${fieldValue(field,change.old)}</span><span aria-label="${esc(t('erre változott'))}" data-i18n-aria-label="erre változott">→</span><span class="new-value">${fieldValue(field,change.new)}</span></dd></div>`).join('')}</dl></details></article>`;
}
function bindItemLinks(container) {container.querySelectorAll('[data-audit-item]:not([disabled])').forEach(button=>button.onclick=()=>detail(+button.dataset.auditItem));}
async function loadAudit(append=false) {
  const result=await api('/api/audit?limit=30'+(append&&auditCursor?'&before='+auditCursor:''));
  if(!append) $('#auditEntries').innerHTML='';
  $('#auditEntries').insertAdjacentHTML('beforeend',result.entries.map(auditHTML).join(''));
  if(!result.entries.length&&!append)$('#auditEntries').innerHTML=`<div class="empty">${msg("A következő műveletek már bekerülnek az auditnaplóba.")}</div>`;
  auditCursor=result.next_before;$('#moreAudit').classList.toggle('hidden',!auditCursor);bindItemLinks($('#auditEntries'));I18n.translate($('#auditEntries'));
}
$('#moreAudit').onclick=async()=>{const button=$('#moreAudit');button.disabled=true;try{await loadAudit(true);}catch(err){notice(err,true);}finally{button.disabled=false;}};
function systemEvent(value){if(value.startsWith('Állapot: '))return msg('Állapot: {status}',{status:value.slice('Állapot: '.length)});if(value.startsWith('Korábban: '))return msg('Korábban: {status}',{status:value.slice('Korábban: '.length)});return ['Felvéve a nyilvántartásba','CSV importtal felvéve',...statuses].includes(value)?msg(value):esc(value);}
function eventText(event,field){const generated=event.kind==='Állapot'&&(['Felvéve a nyilvántartásba','CSV importtal felvéve'].includes(event.title)||event.title.startsWith('Állapot: '));return generated?systemEvent(event[field]):esc(event[field]);}
async function detail(id) {
  try{
    const data=await api(`/api/items/${id}`),item=data.item;
    open(`<div class="actions detail-actions"><button class="danger" id="delete">${msg("Törlés")}</button><button class="ghost" id="close">${msg("Bezárás")}</button><button id="edit">${msg("Szerkesztés")}</button></div><span class="tag">${msg(item.status)}</span><h2 class="detail-title">${esc(item.name)}</h2><p class="sub">${esc([item.brand,item.model,item.serial&&'S/N: '+item.serial].filter(Boolean).join(' · '))}</p><p>${msg(item.category)}${item.location?' · '+esc(item.location):''}${item.price?' · '+esc(item.price):''}</p><p>${msg('Beszerzés módja')}: ${msg(item.acquisition_type||'Ismeretlen')}</p>${item.notes?`<p class="detail-notes">${esc(item.notes)}</p>`:''}<h3>${msg("Fotók és dokumentumok")}</h3><div class="files">${data.attachments.map(file=>`<a target="_blank" rel="noopener" href="/uploads/${file.id}">${file.mime.startsWith('image/')?`<img src="/uploads/${file.id}" alt="">`:''}${esc(file.filename)}</a>`).join('')||`<span class="muted">${msg("Még nincs feltöltés")}</span>`}</div><p><label>${msg("Feltöltés (max. 7 MB)")}<input type="file" id="file" accept="image/*,.pdf,.txt"></label></p><h3>${msg("Eszközváltozások")}</h3><div id="itemAudit" class="muted">${msg("Napló betöltése…")}</div><button id="moreItemAudit" class="ghost hidden">${msg("Régebbi változások")}</button><h3>${msg("Javítási és eseménynapló")}</h3>${data.events.map(event=>`<div class="event"><b>${eventText(event,'title')}</b><small>${esc(event.happened)} · ${msg(event.kind)}</small>${event.details?`<p>${eventText(event,'details')}</p>`:''}</div>`).join('')}<form id="eventForm"><div class="formgrid"><label>${msg("Típus")}<select name="kind">${options(['Javítás','Mérés','Módosítás','Állapot','Tulajdonlás','Vásárlás','Megjegyzés'],'Javítás')}</select></label><label>${msg("Dátum")}<input type="date" name="happened" value="${new Date().toLocaleDateString('sv-SE')}"></label><label class="wide">${msg("Cím")}<input name="title" required maxlength="200"></label><label class="wide">${msg("Részletek")}<textarea name="details" maxlength="10000" placeholder="${esc(t('Tünetek, mért értékek, beavatkozás, eredmény…'))}" data-i18n-placeholder="Tünetek, mért értékek, beavatkozás, eredmény…"></textarea></label></div><div class="actions"><button>${msg("Esemény hozzáadása")}</button></div></form>`);
    const token=modalToken;
    $('#close').onclick=close;$('#edit').onclick=()=>edit(item);$('#delete').onclick=()=>deleteItem(item);
    let cursor=null;
    const itemAudit=async(append=false)=>{
      const log=await api(`/api/audit?item_id=${id}&limit=10`+(append&&cursor?'&before='+cursor:''));
      if(token!==modalToken||!$('#itemAudit')||!$('#eventForm'))return;
      if(!append)$('#itemAudit').innerHTML='';
      $('#itemAudit').insertAdjacentHTML('beforeend',log.entries.map(auditHTML).join(''));
      if(!log.entries.length&&!append)$('#itemAudit').innerHTML=msg('A frissítés óta még nincs rögzített változás.');
      I18n.translate($('#itemAudit'));cursor=log.next_before;$('#moreItemAudit').classList.toggle('hidden',!cursor);
      // Item audit headings refer to the item already open; no nested navigation needed.
      $('#itemAudit').querySelectorAll('[data-audit-item]').forEach(button=>button.disabled=true);
    };
    $('#moreItemAudit').onclick=()=>itemAudit(true).catch(err=>notice(err,true));
    itemAudit().catch(err=>{if(token===modalToken&&$('#itemAudit'))$('#itemAudit').textContent=I18n.error(err.message);});
    $('#eventForm').onsubmit=async event=>{
      event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;
      try{await api(`/api/items/${id}/events`,'POST',Object.fromEntries(new FormData(event.target)));await refresh();await detail(id);notice(t('Esemény rögzítve'));}catch(err){notice(err,true);button.disabled=false;}
    };
    $('#file').onchange=async event=>{
      const file=event.target.files[0];if(!file)return;
      if(file.size>7000000){notice(t('Legfeljebb 7 MB tölthető fel'),true);return;}
      const reader=new FileReader();reader.onload=async()=>{
        try{await api(`/api/items/${id}/attachments`,'POST',{filename:file.name,content:String(reader.result).split(',')[1]});await refresh();await detail(id);notice(t('Fájl feltöltve'));}catch(err){notice(err,true);}
      };reader.onerror=()=>notice(t('A fájl nem olvasható'),true);reader.readAsDataURL(file);
    };
  }catch(err){notice(err,true);}
}
async function deleteItem(item) {
  if(!confirm(t('Törlöd ezt az eszközt: {name}?\nA javítási napló és feltöltött fájlok végleg törlődnek. Az auditnapló és az alkatrészek megmaradnak.',{name:item.name})))return;
  const button=$('#delete');button.disabled=true;
  try{await api(`/api/items/${item.id}`,'DELETE');close();await refresh();if(view==='audit')await loadAudit();notice(t('Eszköz törölve'));}
  catch(err){button.disabled=false;notice(err,true);}
}
start();


$('#csvImport').onclick=()=>{
  open(`<h2>CSV import</h2><p><a class="csv-template" href="/api/import/template" download>${msg("Üres CSV-sablon letöltése")}</a></p><p>${msg("Új tételek felvétele. Kötelező oszlopok: name, category, status. A duplikátumokat nem írjuk felül.")}</p><p class="muted csv-help">${msg("Oszlopok: name,category,brand,model,serial,status,location,acquired,price,acquisition_type,notes,parent_name. UTF-8, vessző / pontosvessző / tabulátor; maximum 1 MB és 500 sor. A parent_name egy meglévő eszköz egyértelmű neve lehet. Az üres beszerzési mód Ismeretlen; a 0 Ft nem jelenti automatikusan azt, hogy ajándék.")}</p><label>${msg("CSV fájl")}<input id="csvFile" type="file" accept=".csv,text/csv"></label><label>${msg("Hibás és duplikált sorok")}<select id="csvMode"><option value="abort" data-i18n="Teljes import megszakítása">Cancel the entire import</option><option value="skip" data-i18n="Hibás sorok kihagyása">Skip invalid rows</option></select></label><div class="actions"><button id="csvPreview">${msg("Előnézet")}</button><button id="csvCommit" disabled>${msg("Importálás")}</button><button id="csvClose" class="ghost">${msg("Bezárás")}</button></div><p id="csvMessage" role="status"></p><div id="csvRows"></div>`);
  const token=modalToken;let csv=null,preview=null,busy=false;
  const update=()=>{for(const id of ['csvFile','csvMode','csvClose'])$('#'+id).disabled=busy;$('#csvCommit').disabled=busy||!preview||!preview.valid||($('#csvMode').value==='abort'&&preview.invalid>0);};
  $('#csvClose').onclick=close;
  $('#csvFile').onchange=()=>{csv=null;preview=null;$('#csvRows').innerHTML='';$('#csvMessage').textContent='';update();};
  $('#csvMode').onchange=update;
  $('#csvPreview').onclick=async()=>{
    if(busy)return;
    const file=$('#csvFile').files[0];
    if(!file){$('#csvMessage').textContent=t('Válassz CSV fájlt.');return;}
    if(file.size>1000000){$('#csvMessage').textContent=t('A fájl maximum 1 MB lehet.');return;}
    busy=true;$('#csvPreview').disabled=true;update();
    try{
      const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());
      const result=await api('/api/import/preview','POST',{csv:text});
      if(token!==modalToken)return;
      csv=text;preview=result;
      $('#csvMessage').innerHTML=msg('{valid} importálható, {invalid} hibás / duplikált sor.',{valid:result.valid,invalid:result.invalid});
      $('#csvRows').innerHTML=result.rows.map(row=>`<article class="event"><b>${msg('{row}. sor · {name}',{row:row.row,name:row.data.name})}</b><p>${msg(row.data.category)} · ${msg(row.data.status)} · ${esc(row.data.location)} · ${esc(row.data.price)}</p><details><summary>${msg("Minden mező")}</summary>${Object.entries(row.data).map(([key,value])=>`<p><strong>${msg(labels[key]||key)}:</strong> ${fieldValue(key,value)}</p>`).join('')}</details><p class="${row.errors.length?'error':'muted'}">${row.errors.length?row.errors.map(error=>msg(I18n.error(error))).join(' · '):msg('Importálható')}</p></article>`).join('');
    }catch(err){if(token===modalToken){preview=null;$('#csvMessage').textContent=I18n.error(err instanceof TypeError&&err.message.includes('encoded')?'Érvénytelen UTF-8 fájl':err.message);}}
    finally{if(token===modalToken){busy=false;$('#csvPreview').disabled=false;update();}}
  };
  $('#csvCommit').onclick=async()=>{
    if(busy||!preview)return;
    busy=true;$('#csvPreview').disabled=true;update();
    try{
      const result=await api('/api/import/commit','POST',{csv,mode:$('#csvMode').value});
      if(token===modalToken)close();
      await refresh();notice(t('{imported} tétel importálva, {skipped} sor kihagyva.',{imported:result.imported,skipped:result.skipped}));
    }catch(err){if(token===modalToken){preview=null;$('#csvMessage').textContent=I18n.error(err instanceof TypeError&&err.message.includes('encoded')?'Érvénytelen UTF-8 fájl':err.message);}}
    finally{if(token===modalToken){busy=false;$('#csvPreview').disabled=false;update();}}
  };
};



document.addEventListener('gear-languagechange',()=>{GearSort.setLocale(I18n.language);if(items.length||!$('#app').classList.contains('hidden')){renderDashboard();renderInventory();}I18n.translate();});
