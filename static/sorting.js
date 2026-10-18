'use strict';
globalThis.GearSort = (() => {
  let collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
  function priceValue(value) {
    // Parse only a leading amount; unknown text such as "ajándék" stays unknown.
    const match = String(value ?? '').trim().match(/^[€$£]?\s*(\d[\d\s\u00a0.,]*)/);
    if (!match) return null;
    let amount = match[1].replace(/[\s\u00a0]/g, '').replace(/[.,]+$/, '');
    if (amount.includes(',') && amount.includes('.')) {
      const decimal = Math.max(amount.lastIndexOf(','), amount.lastIndexOf('.'));
      amount = amount.slice(0, decimal).replace(/[.,]/g, '') + '.' + amount.slice(decimal + 1);
    } else if (/[.,]/.test(amount)) {
      // Groups of three digits are thousands; one/two trailing digits are decimals.
      if (/^\d{1,3}([.,]\d{3})+$/.test(amount)) amount = amount.replace(/[.,]/g, '');
      else amount = amount.replace(',', '.');
    }
    const number = Number(amount);
    return Number.isFinite(number) ? number : null;
  }
  function dateValue(item, field) {
    const value = String(item[field] || '');
    return /^\d{4}-\d{2}-\d{2}/.test(value) ? value : null;
  }
  function sort(rows, selection) {
    const [field, direction] = selection.split(':');
    const sign = direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (field === 'name') return sign * collator.compare(a.name, b.name) || a.id - b.id;
      const av = field === 'price' ? priceValue(a.price) : dateValue(a, field);
      const bv = field === 'price' ? priceValue(b.price) : dateValue(b, field);
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      if (av === null && bv === null) return collator.compare(a.name, b.name) || a.id - b.id;
      return sign * (av < bv ? -1 : av > bv ? 1 : 0) || collator.compare(a.name, b.name) || a.id - b.id;
    });
  }
  function isOwned(item) { return !['Eladva', 'Elajándékozva'].includes(item.status); }
  function matchesStatus(item, status) {
    if(status==='__repair')return ['Hibás','Javítás alatt'].includes(item.status);
    if(status==='__closed')return ['Eladva','Elajándékozva'].includes(item.status);
    return !status || item.status===status;
  }
  function priceCurrency(value) {
    const text=String(value??'');
    if(/€|\bEUR\b/i.test(text))return 'EUR';
    if(/\$|\bUSD\b/i.test(text))return 'USD';
    if(/£|\bGBP\b/i.test(text))return 'GBP';
    if(/\b(?:Ft|HUF)\b/i.test(text))return 'HUF';
    // Amounts with no currency use HUF; unknown currency codes are excluded.
    if(/[a-zA-Z]/.test(text))return null;
    return 'HUF';
  }
  function summary(rows) {
    const owned=rows.filter(isOwned), totals={},counts=new Map(),acquisitions={};let unknown=0,gifts=0;
    for(const item of rows)counts.set(item.category,(counts.get(item.category)||0)+1);
    for(const item of owned){
      const value=priceValue(item.price),currency=priceCurrency(item.price);
      const type=item.acquisition_type||'Ismeretlen';acquisitions[type]=(acquisitions[type]||0)+1;
      if(type==='Ajándék')gifts++;
      if(value===0){totals[currency||'HUF']=(totals[currency||'HUF']||0);continue;}
      if(value===null||currency===null){unknown++;continue;}
      totals[currency]=(totals[currency]||0)+value;
    }
    return {owned:owned.length,inUse:rows.filter(item=>item.status==='Használatban').length,
      repair:rows.filter(item=>matchesStatus(item,'__repair')).length,
      closed:rows.filter(item=>matchesStatus(item,'__closed')).length,
      totals,unknown,gifts,acquisitions,categories:[...counts.entries()].sort((a,b)=>b[1]-a[1]||collator.compare(a[0],b[0]))};
  }
  function setLocale(locale){collator=new Intl.Collator(locale,{numeric:true,sensitivity:'base'});}
  return {setLocale,priceValue, sort, isOwned, matchesStatus, summary};
})();
