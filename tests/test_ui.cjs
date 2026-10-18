const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync,mkdirSync}=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const project=path.resolve(__dirname,'..');
const temporary=mkdtempSync(path.join(os.tmpdir(),'gear-ui-'));
const port=process.env.GEAR_TEST_PORT||'18905';
const base=`http://127.0.0.1:${port}`;
const server=spawn(process.env.PYTHON||'python3',['app.py'],{cwd:project,env:{...process.env,GEAR_PASSWORD:'ui-test-password',GEAR_DATA:temporary,PORT:port},stdio:['ignore','pipe','pipe']});
const logs=[];server.stdout.on('data',d=>logs.push(d.toString()));server.stderr.on('data',d=>logs.push(d.toString()));
(async()=>{
 let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1365,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.accept());
  for(let attempt=0;attempt<50;attempt++){
   try{if((await fetch(base+'/health')).ok)break;}catch{}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  await page.addInitScript(()=>localStorage.setItem('gear.language','hu'));
  await page.goto(base);
  await page.locator('#loginForm [name=password]').fill('ui-test-password');await page.locator('#loginForm button').click();
  await page.locator('#dashboardStats [data-stat="0"]').waitFor();
  await page.evaluate(async()=>{
   for(const body of [
    {name:'Test phone',category:'Telefon',status:'Aktív',price:'0 Ft / Karácsony',acquisition_type:'Ajándék',notes:'keep'},
    {name:'Test laptop',category:'Laptop',status:'Hibás',price:'100 EUR',notes:'keep'},
    {name:'Sold NAS',category:'Szerver / NAS',status:'Eladva',price:'50000 Ft'},
   ])await fetch('/api/items',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  });
  await page.reload();await page.locator('[data-stat="0"] b').filter({hasText:'3'}).waitFor();
  assert.equal(await page.locator('[data-stat="5"] small').allTextContents().then(lines=>lines.join(' | ')),'1 tételt kaptam ajándékba');
  await page.locator('[data-stat="4"]').click();
  assert.equal(await page.locator('#items .card').count(),1);
  assert.equal(await page.locator('#items .card-link h3').textContent(),'Sold NAS');
  await page.locator('#items .card-link').click();await page.locator('#edit').click();
  const forbidden=['Periféria','Audioeszköz','Okosotthon-eszköz','Kábel / adapter','Kijelző / projektor','Szerver / NAS','Hálózat','VR','Egyéb','Egyéb elektronika'];
  const categoryValues=await page.locator('#itemForm [name=category] option').evaluateAll(options=>options.map(option=>option.value));
  for(const value of forbidden)assert.ok(!categoryValues.includes(value),value);
  assert.equal(await page.locator('#itemForm [name=category]').inputValue(),'');
  await page.locator('#itemForm [name=brand]').fill('Legacy brand');
  await page.locator('#itemForm button:not([type=button])').click();await page.locator('#close').waitFor();
  assert.equal(await page.evaluate(()=>fetch('/api/items').then(r=>r.json()).then(items=>items.find(item=>item.name==='Sold NAS').category)),'Szerver / NAS');
  await page.locator('#close').click();
  await page.locator('[data-view=dashboard]').click();await page.locator('.add-item').first().click();
  assert.equal(await page.locator('#itemForm [name=category]').evaluate(select=>select.checkValidity()),false);
  await page.locator('#cancel').click();
  await page.locator('[data-view=dashboard]').click();await page.locator('[data-stat="1"]').click();
  assert.equal(await page.locator('#items .card').count(),2);
  await page.locator('#selectVisible').check();assert.equal(await page.locator('#selectedCount').textContent(),'2 kijelölve');
  await page.locator('#bulkEdit').click();
  await page.locator('[data-enable=category]').check();
  assert.equal(await page.locator('#bulkForm [name=category]').evaluate(select=>select.checkValidity()),false);
  await page.locator('[data-enable=category]').uncheck();
  await page.locator('[data-enable=acquisition_type]').check();await page.locator('#bulkForm [name=acquisition_type]').selectOption('Csere');
  await page.locator('[data-enable=status]').check();await page.locator('#bulkForm [name=status]').selectOption('Használatban');
  await page.locator('[data-enable=location]').check();await page.locator('#bulkForm [name=location]').fill('Műhely');
  await page.locator('#bulkSave').click();await page.locator('#dialog').waitFor({state:'hidden'});
  await page.waitForFunction(()=>document.querySelector('#selectedCount').textContent==='0 kijelölve');
  const data=await page.evaluate(()=>fetch('/api/items').then(r=>r.json()));
  assert.equal(data.filter(x=>x.status==='Használatban').length,2);
  assert.equal(data.filter(x=>x.acquisition_type==='Csere').length,2);
  assert.equal(data.find(x=>x.name==='Test laptop').notes,'keep');
  await page.locator('[data-view=audit]').click();await page.locator('#auditEntries .audit-entry').first().waitFor();
  assert.ok((await page.locator('#auditEntries').textContent()).includes('Közös szerkesztés'));
  await page.locator('#auditEntries details').first().locator('summary').click();
  assert.ok((await page.locator('#auditEntries .new-value').first().textContent()).length>0);
  await page.locator('[data-view=inventory]').click();await page.locator('#items .card-link').first().click();
  await page.locator('#edit').click();await page.locator('#itemForm [name=location]').fill('Polc 2');
  await page.locator('#itemForm [name=acquisition_type]').selectOption('Szívességért');
  await page.locator('#itemForm button:not([type=button])').click();
  await page.locator('#close').waitFor();await page.waitForFunction(()=>document.querySelector('#itemAudit')?.textContent.includes('Polc 2'));
  await page.locator('#close').click();await page.locator('[data-view=dashboard]').click();
  await page.locator('[data-acquisition="Szívességért"]').click();
  assert.equal(await page.locator('#items .card').count(),1);assert.equal(await page.locator('#acquisitionFilter').inputValue(),'Szívességért');
  await page.locator('#clearFilters').click();await page.locator('[data-view=dashboard]').click();
  if(process.env.GEAR_UI_SCREENSHOT_DIR){mkdirSync(process.env.GEAR_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.GEAR_UI_SCREENSHOT_DIR,'dashboard-desktop.png'),fullPage:true});}
  await page.setViewportSize({width:390,height:844});if(process.env.GEAR_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.GEAR_UI_SCREENSHOT_DIR,'dashboard-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  for(const view of ['dashboard','inventory','audit']){
    await page.locator('[data-view='+view+']').click();
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    await page.waitForTimeout(100);
    const positions=await page.evaluate(()=>({header:document.querySelector('header').getBoundingClientRect().top,audit:document.querySelector('.audit-dock').getBoundingClientRect().bottom,height:innerHeight}));
    assert.equal(positions.header,0);assert.ok(positions.audit<=positions.height&&positions.audit>0);
  }
  if(process.env.GEAR_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.GEAR_UI_SCREENSHOT_DIR,'navbar-scrolled-mobile.png')});
  await page.locator('[data-view=dashboard]').click();
  await page.locator('[data-stat="1"]').click();if(process.env.GEAR_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.GEAR_UI_SCREENSHOT_DIR,'inventory-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#csvImport').click();
  await page.locator('#csvFile').setInputFiles({name:'import.csv',mimeType:'text/csv',buffer:Buffer.from('name,category,status,location,notes\nCSV UI tablet,Tablet,Tárolva,Otthon,"Teszt, megjegyzés"\nBad UI,Hálózat,Tárolva,,\n')});
  await page.locator('#csvPreview').click();
  await page.waitForFunction(()=>document.querySelector('#csvMessage').textContent.includes('1 importálható, 1 hibás'));
  assert.equal(await page.locator('#csvCommit').isDisabled(),true);
  assert.ok((await page.locator('#csvRows').textContent()).includes('Ismeretlen kategória'));
  if(process.env.GEAR_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.GEAR_UI_SCREENSHOT_DIR,'csv-preview-mobile.png'),fullPage:true});
  await page.locator('#csvMode').selectOption('skip');
  assert.equal(await page.locator('#csvCommit').isEnabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#csvCommit').click();await page.waitForFunction(()=>!document.querySelector('#dialog').open);
  const imported=await page.evaluate(()=>fetch('/api/items').then(r=>r.json()).then(rows=>rows.find(item=>item.name==='CSV UI tablet')));
  assert.equal(imported.acquisition_type,'Ismeretlen');assert.equal(imported.category,'Tablet');assert.equal(imported.notes,'Teszt, megjegyzés');
  const log=await page.evaluate(id=>fetch('/api/audit?item_id='+id).then(r=>r.json()),imported.id);
  assert.equal(log.entries[0].action,'import');
  const downloadEvent=page.waitForEvent('download');await page.locator('a[href^="/api/export"]').click();
  const download=await downloadEvent;assert.equal(download.suggestedFilename(),'gear-inventory.csv');
  assert.deepEqual(errors,[]);
  console.log('UI passed: login, category cleanup and legacy preservation, dashboard filters, selection, bulk edits, audit, single edit, acquisition forms and filters, CSV preview and import, mobile overflow');
 }finally{if(browser)await browser.close();server.kill();await new Promise(resolve=>server.once('exit',resolve));rmSync(temporary,{recursive:true,force:true});}
})().catch(err=>{console.error(err);console.error(logs.join(''));process.exitCode=1});
