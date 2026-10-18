"""Run with python3 tests/test_api.py; uses only temporary data."""
import csv
import io
import base64
import http.cookiejar
import importlib.util
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

temp = tempfile.TemporaryDirectory()
os.environ['GEAR_DATA'] = temp.name
os.environ['GEAR_PASSWORD'] = 'test-password'
# Mimic an existing v0.3 database before importing the new startup migration.
with sqlite3.connect(Path(temp.name)/'gear.sqlite3') as legacy:
    legacy.executescript('''CREATE TABLE items (
      id INTEGER PRIMARY KEY,name TEXT NOT NULL,category TEXT NOT NULL DEFAULT 'Egyéb',
      brand TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',serial TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Aktív',location TEXT NOT NULL DEFAULT '',acquired TEXT NOT NULL DEFAULT '',
      price TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',parent_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO items (id,name,category,notes) VALUES (41,'Legacy NAS','Szerver / NAS','Preserve this');''')
spec = importlib.util.spec_from_file_location('gear_app', Path(__file__).parents[1] / 'app.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)

class InventoryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        temp.cleanup()

    def request(self, opener, path, method='GET', data=None):
        request = urllib.request.Request(self.base + path, method=method,
            data=None if data is None else json.dumps(data).encode(),
            headers={'Content-Type':'application/json'})
        try: response = opener.open(request)
        except urllib.error.HTTPError as err: response = err
        return response.status, json.loads(response.read())

    def test_status_and_deletion(self):
        anonymous = urllib.request.build_opener()
        client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.assertEqual(self.request(anonymous, '/api/items/1', 'DELETE')[0], 401)
        self.assertEqual(self.request(client, '/api/login', 'POST', {'password':'test-password'})[0], 200)
        code, parent = self.request(client, '/api/items', 'POST', {'name':'Parent', 'status':'Használatban'})
        self.assertEqual(code, 201)
        parent_id = parent['id']
        _, child = self.request(client, '/api/items', 'POST', {'name':'Component','parent_id':parent_id})
        self.assertEqual(self.request(client, f'/api/items/{parent_id}')[1]['item']['status'], 'Használatban')
        self.assertEqual(self.request(client, f'/api/items/{parent_id}/attachments','POST',
            {'filename':'note.txt', 'content':base64.b64encode(b'test attachment').decode()})[0], 201)
        self.assertEqual(len(list((app.DATA / 'uploads').iterdir())), 1)
        self.assertEqual(self.request(client, f'/api/items/{parent_id}', 'DELETE')[0], 200)
        self.assertEqual(self.request(client, f'/api/items/{parent_id}')[0], 404)
        self.assertEqual(self.request(client, f'/api/items/{parent_id}', 'DELETE')[0], 404)
        self.assertIsNone(self.request(client, f"/api/items/{child['id']}")[1]['item']['parent_id'])
        with app.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM events WHERE item_id=?',(parent_id,)).fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM attachments WHERE item_id=?',(parent_id,)).fetchone()[0], 0)
        self.assertEqual(list((app.DATA / 'uploads').iterdir()), [])

    def client(self):
        client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.assertEqual(self.request(client,'/api/login','POST',{'password':'test-password'})[0],200)
        return client

    def test_existing_database_migration(self):
        client=self.client()
        item=self.request(client,'/api/items/41')[1]['item']
        self.assertEqual(item['name'],'Legacy NAS');self.assertEqual(item['category'],'Szerver / NAS');self.assertEqual(item['notes'],'Preserve this')
        self.assertEqual(self.request(client,'/api/audit?item_id=41')[1]['entries'],[])

    def test_bulk_and_audit_atomicity(self):
        client=self.client()
        ids=[self.request(client,'/api/items','POST',{'name':name,'status':'Aktív','notes':'keep','price':'500 Ft'})[1]['id'] for name in ('Bulk A','Bulk B')]
        anonymous=urllib.request.build_opener()
        self.assertEqual(self.request(anonymous,'/api/items/bulk','POST',{'ids':ids,'changes':{'status':'Hibás'}})[0],401)
        self.assertEqual(self.request(anonymous,'/api/audit')[0],401)
        code,result=self.request(client,'/api/items/bulk','POST',{'ids':ids,'changes':{'status':'Használatban','location':'Polc'}})
        self.assertEqual(code,200);self.assertEqual(result['updated'],2)
        for item_id in ids:
            item=self.request(client,f'/api/items/{item_id}')[1]['item']
            self.assertEqual(item['status'],'Használatban');self.assertEqual(item['location'],'Polc');self.assertEqual(item['notes'],'keep')
            entries=self.request(client,f'/api/audit?item_id={item_id}')[1]['entries']
            self.assertEqual(entries[0]['batch_id'],result['batch_id'])
            self.assertEqual(entries[0]['changes']['status'],{'old':'Aktív','new':'Használatban'})
            self.assertEqual(entries[0]['changes']['location'],{'old':'','new':'Polc'})
        count=len(self.request(client,f'/api/audit?item_id={ids[0]}')[1]['entries'])
        self.assertEqual(self.request(client,'/api/items/bulk','POST',{'ids':ids,'changes':{'status':'Használatban'}})[1]['updated'],0)
        self.assertEqual(len(self.request(client,f'/api/audit?item_id={ids[0]}')[1]['entries']),count)
        self.assertEqual(self.request(client,'/api/items/bulk','POST',{'ids':[ids[0],999999],'changes':{'location':'wrong'}})[0],400)
        self.assertEqual(self.request(client,f'/api/items/{ids[0]}')[1]['item']['location'],'Polc')
        self.assertEqual(len(self.request(client,f'/api/audit?item_id={ids[0]}')[1]['entries']),count)
        for payload in ({'ids':ids,'changes':{'name':'not allowed'}},{'ids':ids,'changes':{'status':''}},{'ids':[True],'changes':{'location':'bad'}}):
            self.assertEqual(self.request(client,'/api/items/bulk','POST',payload)[0],400)
        self.assertEqual(self.request(client,'/api/items/bulk','POST',{'ids':ids,'changes':{'notes':''}})[1]['updated'],2)
        self.assertEqual(self.request(client,f'/api/items/{ids[0]}')[1]['item']['notes'],'')
        first=self.request(client,'/api/audit?limit=1')[1]
        second=self.request(client,f"/api/audit?limit=1&before={first['next_before']}")[1]
        self.assertLess(second['entries'][0]['id'],first['entries'][0]['id'])

    def test_single_edit_delete_and_id_history(self):
        client=self.client()
        item_id=self.request(client,'/api/items','POST',{'name':'Audit device','price':'100 Ft'})[1]['id']
        item=self.request(client,f'/api/items/{item_id}')[1]['item'];item['price']='200 Ft';item['category']='Telefon'
        self.assertEqual(self.request(client,f'/api/items/{item_id}','PUT',item)[0],200)
        log=self.request(client,f'/api/audit?item_id={item_id}')[1]['entries'][0]
        self.assertEqual(log['action'],'update');self.assertEqual(log['changes']['price'],{'old':'100 Ft','new':'200 Ft'})
        count=len(self.request(client,f'/api/audit?item_id={item_id}')[1]['entries'])
        self.request(client,f'/api/items/{item_id}','PUT',item)
        self.assertEqual(len(self.request(client,f'/api/audit?item_id={item_id}')[1]['entries']),count)
        self.request(client,f'/api/items/{item_id}','DELETE')
        entries=self.request(client,f'/api/audit?item_id={item_id}')[1]['entries']
        self.assertEqual(entries[0]['action'],'delete');self.assertEqual(entries[0]['item_exists'],0)
        replacement=self.request(client,'/api/items','POST',{'name':'New after delete'})[1]['id']
        self.assertGreater(replacement,item_id)

    def test_csv_import(self):
        client=self.client()
        anonymous=urllib.request.build_opener()
        self.assertEqual(self.request(anonymous,'/api/import/preview','POST',{'csv':'x'})[0],401)
        _,parent=self.request(client,'/api/items','POST',{'name':'CSV parent'})
        text='\ufeffname;category;status;brand;model;price;notes;parent_name\r\nCSV phone;Telefon;Tárolva;Samsung;Sample;0 Ft;"Hello; world\nSecond line";CSV parent\r\nBad;Hálózat;Nope;;;;;\r\n'
        code,preview=self.request(client,'/api/import/preview','POST',{'csv':text})
        self.assertEqual(code,200);self.assertEqual((preview['valid'],preview['invalid']),(1,1))
        self.assertEqual(preview['rows'][0]['item']['parent_id'],parent['id'])
        before=len(self.request(client,'/api/items')[1])
        self.assertEqual(self.request(client,'/api/import/commit','POST',{'csv':text})[0],409)
        self.assertEqual(len(self.request(client,'/api/items')[1]),before)
        code,result=self.request(client,'/api/import/commit','POST',{'csv':text,'mode':'skip'})
        self.assertEqual(code,201);self.assertEqual((result['imported'],result['skipped']),(1,1))
        item_id=result['ids'][0]
        detail=self.request(client,f'/api/items/{item_id}')[1]
        self.assertEqual(detail['item']['notes'],'Hello; world\nSecond line')
        self.assertEqual(len(detail['events']),1)
        audit=self.request(client,f'/api/audit?item_id={item_id}')[1]['entries'][0]
        self.assertEqual(audit['action'],'import');self.assertEqual(audit['batch_id'],result['batch_id'])
        self.assertIsNone(audit['changes']['name']['old'])
        repeated=self.request(client,'/api/import/commit','POST',{'csv':text,'mode':'skip'})[1]
        self.assertEqual(repeated['imported'],0)
        cases=[
            'name,category,status\nA,Telefon,Tárolva\n a ,Telefon,Tárolva\n',
            'name,category,status,acquired\nB,Telefon,Tárolva,2026-02-30\n',
            'name,category,status,parent_name\nC,Tablet,Tárolva,Missing parent\n',
            'name,category,status,brand\nD,Tablet,Tárolva,'+'x'*101+'\n',
        ]
        for csv in cases:
            response=self.request(client,'/api/import/preview','POST',{'csv':csv})
            self.assertEqual(response[0],200);self.assertEqual(response[1]['invalid'],1)
        for csv in ['name,category,status,extra\nA,Telefon,Tárolva,x','name,name,category,status\nA,A,Telefon,Tárolva','name,category,status\n']:
            self.assertEqual(self.request(client,'/api/import/preview','POST',{'csv':csv})[0],400)
        # Preview is not a reservation: changes after preview are checked again.
        csv='name,category,status\nRace CSV,Telefon,Tárolva\n'
        self.assertEqual(self.request(client,'/api/import/preview','POST',{'csv':csv})[1]['valid'],1)
        self.request(client,'/api/items','POST',{'name':'Race CSV','category':'Telefon','status':'Tárolva'})
        self.assertEqual(self.request(client,'/api/import/commit','POST',{'csv':csv})[0],409)

    def test_acquisition_model(self):
        client=self.client()
        self.assertEqual(self.request(client,'/api/items/41')[1]['item']['acquisition_type'],'Ismeretlen')
        code,created=self.request(client,'/api/items','POST',{'name':'Explicit acquisition','category':'Telefon','price':'0 Ft','acquisition_type':'Csere'})
        self.assertEqual(code,201);id=created['id']
        self.assertEqual(self.request(client,f'/api/items/{id}')[1]['item']['acquisition_type'],'Csere')
        self.assertEqual(self.request(client,f'/api/items/{id}','PUT',{'name':'Explicit acquisition','category':'Telefon','price':'0 Ft'})[0],200)
        self.assertEqual(self.request(client,f'/api/items/{id}')[1]['item']['acquisition_type'],'Csere')
        for invalid in ['Mystery',42,None]:
            self.assertEqual(self.request(client,'/api/items','POST',{'name':'Invalid','acquisition_type':invalid})[0],400)
        self.assertEqual(self.request(client,'/api/items/bulk','POST',{'ids':[id],'changes':{'acquisition_type':'Ajándék'}})[0],200)
        entry=self.request(client,f'/api/audit?item_id={id}')[1]['entries'][0]
        self.assertEqual(entry['changes']['acquisition_type'],{'old':'Csere','new':'Ajándék'})
        self.assertEqual(self.request(client,'/api/items/bulk','POST',{'ids':[id],'changes':{'acquisition_type':'Nope'}})[0],400)
        csv_text='name,category,status,price,acquisition_type\nAcq default,Telefon,Tárolva,0 Ft,\nAcq gift,Tablet,Tárolva,,Ajándék\nAcq invalid,Router,Tárolva,0 Ft,Nope\n'
        preview=self.request(client,'/api/import/preview','POST',{'csv':csv_text})[1]
        self.assertEqual((preview['valid'],preview['invalid']),(2,1))
        self.assertEqual(preview['rows'][0]['data']['acquisition_type'],'Ismeretlen')
        imported=self.request(client,'/api/import/commit','POST',{'csv':csv_text,'mode':'skip'})[1]
        self.assertEqual(imported['imported'],2)
        for i,expected in zip(imported['ids'],['Ismeretlen','Ajándék']):
            self.assertEqual(self.request(client,f'/api/items/{i}')[1]['item']['acquisition_type'],expected)
        anonymous=urllib.request.build_opener()
        self.assertEqual(self.request(anonymous,'/api/export')[0],401)
        response=client.open(self.base+'/api/export')
        self.assertIn('text/csv',response.headers['Content-Type'])
        records=list(csv.DictReader(io.StringIO(response.read().decode('utf-8-sig'))))
        self.assertEqual(next(row for row in records if row['name']=='Explicit acquisition')['acquisition_type'],'Gift')
        template=client.open(self.base+'/api/import/template').read().decode('utf-8-sig')
        self.assertEqual(next(csv.reader(io.StringIO(template))),list(app.CSV_FIELDS))
        # Backward-compatible files lacking the new column remain importable.
        with app.connect() as db:
            result=app.csv_preview(db,'name,category,status,price\nAcq old file,Telefon,Tárolva,0 Ft\n')
        self.assertEqual(result['rows'][0]['item']['acquisition_type'],'Ismeretlen')

    def test_languages_and_csv_aliases(self):
        client=self.client()
        for language,expected in [('en','Name is required'),('hu','Név szükséges')]:
            request=urllib.request.Request(self.base+'/api/items',data=b'{}',method='POST',headers={'Content-Type':'application/json','Accept-Language':language})
            try: response=client.open(request)
            except urllib.error.HTTPError as error: response=error
            self.assertEqual(response.status,400)
            self.assertEqual(response.headers['Content-Language'],language)
            self.assertEqual(json.loads(response.read())['error'],expected)
        csv_text='name,category,status,acquisition_type\nEnglish alias example,Phone,In use,Gift\n'
        result=self.request(client,'/api/import/commit','POST',{'csv':csv_text})[1]
        item=self.request(client,f"/api/items/{result['ids'][0]}")[1]['item']
        self.assertEqual((item['category'],item['status'],item['acquisition_type']),('Telefon','Használatban','Ajándék'))
        for language,expected in [('en','Gift'),('hu','Ajándék')]:
            content=client.open(self.base+'/api/export?lang='+language).read().decode('utf-8-sig')
            records=list(csv.DictReader(io.StringIO(content)))
            self.assertEqual(next(row for row in records if row['name']=='English alias example')['acquisition_type'],expected)
        with app.connect() as db:
            for group in ('categories','statuses','acquisition_types'):
                for value in app.CATALOG[group]:
                    self.assertEqual(app.canonical(app.translated(value),group),value)
        for route in ['/i18n.js','/translations.json']:
            self.assertEqual(client.open(self.base+route).status,200)
        for route in ['/.env','/session.key','/seed.py','/.git/config']:
            self.assertEqual(self.request(client,route)[0],404)
        # Non-ASCII passwords are compared as UTF-8, not unsupported Python strings.
        original=app.PASSWORD
        try:
            app.PASSWORD='Test-áé-unique-password'
            self.assertEqual(self.request(client,'/api/login','POST',{'password':app.PASSWORD})[0],200)
        finally: app.PASSWORD=original

if __name__ == '__main__': unittest.main()
