const assert = require('node:assert/strict');
require('../static/sorting.js');
const {priceValue, sort} = globalThis.GearSort;
for (const [input, expected] of [['2 000 Ft',2000], ['15.000 Ft',15000], ['1.234,50',1234.5],
  ['1,234.50',1234.5], ['0 Ft',0], ['ajándék',null], ['',null], ['129,99 EUR',129.99]]) {
  assert.equal(priceValue(input), expected, input);
}
const items = [
  {id:1,name:'Zebra',price:'ajándék',acquired:''},
  {id:2,name:'Ábel 10',price:'10 000 Ft',acquired:'2026-10-01'},
  {id:3,name:'Ábel 2',price:'900 Ft',acquired:'2026-09-01'},
  {id:4,name:'Beta',price:'0 Ft',acquired:''},
];
const ids = mode => sort(items, mode).map(x=>x.id);
assert.deepEqual(ids('name:asc'),[3,2,4,1]);
assert.deepEqual(ids('name:desc'),[1,4,2,3]);
assert.deepEqual(ids('price:asc'),[4,3,2,1]);
assert.deepEqual(ids('price:desc'),[2,3,4,1]);
assert.deepEqual(ids('acquired:asc'),[3,2,4,1]);
assert.deepEqual(ids('acquired:desc'),[2,3,4,1]);
assert.deepEqual(items.map(x=>x.id),[1,2,3,4]);
assert.equal(GearSort.isOwned({status:'Eladva'}),false);
assert.equal(GearSort.isOwned({status:'Elajándékozva'}),false);
for(const status of ['Aktív','Használatban','Hibás','Tárolva','Szétszedve']) assert.equal(GearSort.isOwned({status}),true);
console.log('Sorting and ownership tests passed');
assert.equal(GearSort.matchesStatus({status:'Hibás'},'__repair'),true);
assert.equal(GearSort.matchesStatus({status:'Tárolva'},'__repair'),false);
const summary=GearSort.summary([
  {category:'Telefon',status:'Használatban',price:'20 000 Ft'},
  {category:'Telefon',status:'Hibás',price:'100 EUR'},
  {category:'NAS',status:'Eladva',price:'50000 Ft'},
  {category:'Laptop',status:'Elajándékozva',price:'90000 Ft'},
  {category:'Router',status:'Javítás alatt',price:''},
  {category:'Alkatrész',status:'Tárolva',price:'0'},
]);
assert.equal(summary.owned,4);assert.equal(summary.closed,2);assert.equal(summary.repair,2);assert.equal(summary.inUse,1);
assert.deepEqual(summary.totals,{HUF:20000,EUR:100});assert.equal(summary.unknown,1);
assert.deepEqual(summary.categories[0],['Telefon',2]);
console.log('Dashboard tests passed');

assert.equal(summary.gifts,0);
const gifts=GearSort.summary([{status:'Tárolva',price:'0 Ft / Karácsony'},{status:'Használatban',price:'0'},{status:'Elajándékozva',price:'0 Ft'},{status:'Tárolva',price:''}]);
assert.equal(gifts.gifts,0);assert.equal(gifts.unknown,1);
assert.equal(GearSort.summary([{status:'Tárolva',price:'100 Ft'}]).unknown,0);
console.log('Gift price summary tests passed');


const explicit=GearSort.summary([
 {status:'Tárolva',price:'0 Ft',acquisition_type:'Csere'},
 {status:'Használatban',price:'10000 Ft',acquisition_type:'Ajándék'},
 {status:'Tárolva',price:'',acquisition_type:'Ajándék'},
 {status:'Eladva',price:'0 Ft',acquisition_type:'Ajándék'},
]);
assert.equal(explicit.gifts,2);assert.deepEqual(explicit.acquisitions,{'Csere':1,'Ajándék':2});
assert.equal(explicit.unknown,1);assert.equal(summary.acquisitions.Ismeretlen,4);
console.log('Explicit acquisition summary passed');
