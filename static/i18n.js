'use strict';
globalThis.I18n=(()=>{
  let language='en',dictionary={},reverse={};
  try{if(localStorage.getItem('gear.language')==='hu')language='hu';}catch{}
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const key=value=>reverse[value]||value;
  function t(source,vars={}){
    source=key(String(source));
    let result=language==='en'?(dictionary[source]||source):source;
    if(language==='en'){
      if(vars.n===1)result=result.replace('items have','item has').replace(/\bitems\b/g,'item').replace('fields / events','field / event').replace('received as gifts','received as a gift');
      for(const count of ['imported','skipped','updated','unchanged'])if(vars[count]===1)result=result.replace('{'+count+'} items','{'+count+'} item').replace('{'+count+'} rows','{'+count+'} row');
      if(vars.visible===1)result=result.replace('{visible} matches','{visible} match');
      if(vars.total===1)result=result.replace('{total} items','{total} item');
    }
    return result.replace(/\{(\w+)\}/g,(_,name)=>String((['field','status'].includes(name)||(name==='value'&&source==='Jelenlegi: {value} (korábbi kategória)'))?t(vars[name]??''):vars[name]??''));
  }
  function msg(source,vars={}){const match=String(source).match(/^(.+): (túl hosszú érték|value is too long)$/);if(match){source='{field}: túl hosszú érték';vars={field:match[1]};}return `<span data-i18n="${escape(key(source))}" data-i18n-vars="${escape(JSON.stringify(vars))}">${escape(t(source,vars))}</span>`;}
  function translate(root=document){
    root.querySelectorAll('[data-i18n]').forEach(el=>{let vars={};try{vars=JSON.parse(el.dataset.i18nVars||'{}');}catch{}el.textContent=t(el.dataset.i18n,vars);});
    for(const attr of ['placeholder','aria-label'])root.querySelectorAll('[data-i18n-'+attr+']').forEach(el=>el.setAttribute(attr,t(el.getAttribute('data-i18n-'+attr))));
    root.querySelectorAll('[data-i18n-date]').forEach(el=>el.textContent=dateTime(el.dataset.i18nDate));
    for(const id of ['loginError','csvMessage','toast']){const el=document.getElementById(id);if(el&&!el.childElementCount&&el.textContent)el.textContent=error(el.textContent);}
    root.querySelectorAll('.language-select').forEach(el=>{el.value=language;el.onchange=()=>setLanguage(el.value);});
    document.documentElement.lang=language;
    document.querySelectorAll('a[href^="/api/export"]').forEach(a=>a.href='/api/export?lang='+language);
  }
  function dateTime(value){const date=new Date(value.replace(' ','T')+'Z');return Number.isNaN(+date)?value:date.toLocaleString(locale());}
  function locale(){return language==='hu'?'hu-HU':'en-GB';}
  function setLanguage(value){
    if(!['en','hu'].includes(value))return;
    language=value;try{localStorage.setItem('gear.language',value);}catch{}
    translate();document.dispatchEvent(new Event('gear-languagechange'));
  }
  function picker(){return `<label class="language-picker"><span data-i18n="Nyelv">${t('Nyelv')}</span><select class="language-select" aria-label="${t('Nyelv')}" data-i18n-aria-label="Nyelv"><option value="en" lang="en">English</option><option value="hu" lang="hu">Magyar</option></select></label>`;}
  function error(value){
    const match=String(value).match(/^(.+): (túl hosszú érték|value is too long)$/);
    return match?t('{field}: túl hosszú érték',{field:match[1]}):t(value);
  }
  const ready=fetch('/translations.json').then(r=>{if(!r.ok)throw Error('Cannot load translations');return r.json();}).then(data=>{dictionary=data;reverse=Object.fromEntries(Object.entries(data).map(([hu,en])=>[en,hu]));translate();});
  return {t,msg,translate,setLanguage,picker,ready,error,locale,dateTime,get language(){return language;}};
})();
