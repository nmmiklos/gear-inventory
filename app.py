import csv
import io
from datetime import date
import base64
import hashlib
import hmac
import html
import json
import mimetypes
import os
import secrets
import sqlite3
import time
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DATA = Path(os.getenv('GEAR_DATA', '/data'))
DATA.mkdir(parents=True, exist_ok=True)
(DATA / 'uploads').mkdir(exist_ok=True)
DB = DATA / 'gear.sqlite3'
PASSWORD = os.getenv('GEAR_PASSWORD', '')
COOKIE_SECURE = os.getenv('GEAR_COOKIE_SECURE','').lower() in ('1','true','yes')
SECRET_FILE = DATA / 'session.key'
if not SECRET_FILE.exists():
    SECRET_FILE.write_bytes(secrets.token_bytes(32))
    SECRET_FILE.chmod(0o600)
SECRET = SECRET_FILE.read_bytes()

def connect():
    db = sqlite3.connect(DB, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA foreign_keys=ON')
    return db

with connect() as db:
    db.executescript('''
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Egyéb',
      brand TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', serial TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Aktív', location TEXT NOT NULL DEFAULT '',
      acquired TEXT NOT NULL DEFAULT '', price TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
      parent_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, happened TEXT NOT NULL DEFAULT (date('now')),
      title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, stored TEXT NOT NULL UNIQUE, mime TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
    CREATE INDEX IF NOT EXISTS idx_events_item ON events(item_id, happened DESC);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
      item_name TEXT NOT NULL, action TEXT NOT NULL, changes TEXT NOT NULL,
      batch_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_item ON audit_log(item_id,id DESC);
    ''')

    # Additive migration: preserve existing prices and classifications.
    if 'acquisition_type' not in {row['name'] for row in db.execute('PRAGMA table_info(items)')}:
        db.execute("ALTER TABLE items ADD COLUMN acquisition_type TEXT NOT NULL DEFAULT 'Ismeretlen'")

BASE = Path(__file__).with_name('static')
FIELDS = ('name','category','brand','model','serial','status','location','acquired','price','acquisition_type','notes','parent_id')
KINDS = ('Állapot','Javítás','Mérés','Módosítás','Tulajdonlás','Vásárlás','Megjegyzés')
CATALOG = json.loads((BASE/'catalog.json').read_text())
TRANSLATIONS = json.loads((BASE/'translations.json').read_text())

def translated(value, language='en'):
    if language=='hu': return value
    if value.endswith(': túl hosszú érték'):
        return value.removesuffix(': túl hosszú érték')+': value is too long'
    return TRANSLATIONS.get(value,value)

def public_error(exc):
    value=str(exc)
    if value in TRANSLATIONS or value.endswith(': túl hosszú érték'): return value
    return 'Érvénytelen adat vagy hivatkozás'

def canonical(value, group):
    if not isinstance(value,str): return value
    for option in CATALOG[group]:
        if value.strip().casefold() in (option.casefold(),translated(option).casefold()): return option
    return value.strip()

CSV_FIELDS = (*FIELDS[:-1], 'parent_name')
CSV_LIMITS = dict(zip(CSV_FIELDS, (200,80,100,120,120,80,120,30,80,80,10000,200)))

BULK_FIELDS = ('status','category','location','brand','model','acquired','price','acquisition_type','notes')

def acquisition_type(value):
    if not isinstance(value,str): raise ValueError('Érvénytelen beszerzési mód')
    value=canonical(value,'acquisition_types') or 'Ismeretlen'
    if value not in CATALOG['acquisition_types']: raise ValueError('Ismeretlen beszerzési mód')
    return value

def csv_preview(db, text):
    if not isinstance(text,str) or len(text.encode('utf-8'))>1_000_000:
        raise ValueError('A CSV maximum 1 MB lehet')
    text=text.lstrip('\ufeff')
    try:
        delimiter=csv.Sniffer().sniff(text[:8192],delimiters=',;\t').delimiter
    except csv.Error: delimiter=','
    reader=csv.DictReader(io.StringIO(text,newline=''),delimiter=delimiter,strict=True)
    headers=reader.fieldnames or []
    if len(headers)!=len(set(headers)) or any(h not in CSV_FIELDS for h in headers):
        raise ValueError('Ismeretlen vagy ismétlődő CSV oszlop')
    if not {'name','category','status'}.issubset(headers):
        raise ValueError('Kötelező oszlopok: name, category, status')
    existing=db.execute('SELECT * FROM items').fetchall()
    norm=lambda value: value.strip().casefold()
    seen={tuple(norm(item[k]) for k in ('name','brand','model')) for item in existing}
    parents={}
    for item in existing: parents.setdefault(norm(item['name']),[]).append(item['id'])
    rows=[]
    try:
        for number,raw in enumerate(reader,2):
            if len(rows)>=500: raise ValueError('Maximum 500 CSV sor importálható')
            errors=[]
            if None in raw or any(v is None for v in raw.values()): errors.append('Hibás oszlopszám')
            data={key:(raw.get(key) or '').strip() for key in CSV_FIELDS}
            for key,value in data.items():
                if len(value)>CSV_LIMITS[key]: errors.append(f'{key}: túl hosszú érték')
            data['category']=canonical(data['category'],'categories');data['status']=canonical(data['status'],'statuses')
            try: data['acquisition_type']=acquisition_type(data['acquisition_type'])
            except ValueError as exc: errors.append(str(exc))
            if not data['name']: errors.append('Név szükséges')
            if data['category'] not in CATALOG['categories']: errors.append('Ismeretlen kategória')
            if data['status'] not in CATALOG['statuses']: errors.append('Ismeretlen állapot')
            if data['acquired']:
                try:
                    if date.fromisoformat(data['acquired']).isoformat()!=data['acquired']: raise ValueError()
                except ValueError: errors.append('Vásárlás dátuma: YYYY-MM-DD szükséges')
            identity=tuple(norm(data[k]) for k in ('name','brand','model'))
            if identity in seen: errors.append('Duplikátum: név + márka + modell')
            parent=None
            if data['parent_name']:
                matches=parents.get(norm(data['parent_name']),[])
                if len(matches)!=1: errors.append('A szülő neve nem található vagy nem egyértelmű')
                else: parent=matches[0]
            item={key:data[key] for key in FIELDS[:-1]};item['parent_id']=parent
            rows.append({'row':number,'data':data,'item':item,'errors':errors})
            if not errors: seen.add(identity)
    except csv.Error: raise ValueError('Hibás CSV formátum')
    if not rows: raise ValueError('A CSV nem tartalmaz tételeket')
    return {'rows':rows,'valid':sum(not row['errors'] for row in rows),'invalid':sum(bool(row['errors']) for row in rows)}

def audit(db, item, action, changes, batch_id=''):
    db.execute('INSERT INTO audit_log (item_id,item_name,action,changes,batch_id) VALUES (?,?,?,?,?)',
               (item['id'],item['name'],action,json.dumps(changes,ensure_ascii=False),batch_id))

def next_item_id(db):
    # Deleted-item audit entries retain their IDs; do not assign them to new devices.
    return db.execute('SELECT max(id)+1 FROM (SELECT id FROM items UNION ALL SELECT item_id AS id FROM audit_log)').fetchone()[0] or 1

def update_item(db, item, changes, action='update', batch_id=''):
    changed={key:{'old':item[key],'new':value} for key,value in changes.items() if item[key]!=value}
    if not changed: return False
    db.execute('UPDATE items SET '+','.join(f'{key}=?' for key in changed)+",updated_at=datetime('now') WHERE id=?",
               (*[change['new'] for change in changed.values()],item['id']))
    audit(db,item,action,changed,batch_id)
    if 'status' in changed:
        db.execute('INSERT INTO events (item_id,kind,title,details) VALUES (?,?,?,?)',
                   (item['id'],'Állapot',f"Állapot: {changes['status']}",f"Korábban: {item['status']}"))
    return True

class Handler(BaseHTTPRequestHandler):
    def language(self):
        query=urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        value=query.get('lang',[self.headers.get('Accept-Language','en')])[0]
        return 'hu' if value.lower().startswith('hu') else 'en'

    def respond(self, code, obj=None, content_type='application/json; charset=utf-8', raw=None, extra=None):
        if isinstance(obj,dict):
            if 'error' in obj: obj={**obj,'error':translated(obj['error'],self.language())}
            if 'rows' in obj and 'valid' in obj:
                obj={**obj,'rows':[{**row,'errors':[translated(error,self.language()) for error in row['errors']]} for row in obj['rows']]}
        data = raw if raw is not None else json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Language',self.language())
        if extra:
            for k,v in extra.items(): self.send_header(k,v)
        self.end_headers()
        self.wfile.write(data)

    def auth(self):
        if not PASSWORD: return False
        cookie = cookies.SimpleCookie()
        try: cookie.load(self.headers.get('Cookie',''))
        except cookies.CookieError: return False
        value = cookie.get('gear_session')
        if not value: return False
        try:
            expiry, sig = value.value.split('.',1)
            expected = hmac.new(SECRET, expiry.encode(),hashlib.sha256).hexdigest()
            return int(expiry) > time.time() and hmac.compare_digest(sig, expected)
        except (ValueError,TypeError): return False

    def payload(self, limit=1_000_000):
        length = int(self.headers.get('Content-Length','0'))
        if length < 0 or length > limit: raise ValueError('Túl nagy kérés')
        data=json.loads(self.rfile.read(length))
        if not isinstance(data,dict): raise ValueError('JSON objektum szükséges')
        return data

    def route(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = [p for p in parsed.path.split('/') if p]
        return parts, urllib.parse.parse_qs(parsed.query)

    def do_GET(self):
        parts, query = self.route()
        if parts == ['health']:
            return self.respond(200,{'ok':True})
        if not self.auth():
            if parts == ['api','me']: return self.respond(401,{'error':'Bejelentkezés szükséges'})
            if parts[:1] == ['api'] or parts[:1] == ['uploads']: return self.respond(401,{'error':'Bejelentkezés szükséges'})
        if parts == ['api','me']: return self.respond(200,{'ok':True})
        if parts == ['api','catalog']: return self.respond(200,CATALOG)
        if parts == ['api','export']:
            with connect() as db:
                rows=db.execute('SELECT * FROM items ORDER BY id').fetchall()
            names={row['id']:row['name'] for row in rows}
            output=io.StringIO(newline='');writer=csv.writer(output);writer.writerow(CSV_FIELDS)
            for row in rows:
                writer.writerow([translated(row[key],self.language()) if key in ('category','status','acquisition_type') else row[key] for key in FIELDS[:-1]]+[names.get(row['parent_id'],'')])
            return self.respond(200,raw=('\ufeff'+output.getvalue()).encode('utf-8'),content_type='text/csv; charset=utf-8',extra={'Content-Disposition':'attachment; filename="gear-inventory.csv"'})
        if parts == ['api','import','template']:
            output=io.StringIO(newline='');csv.writer(output).writerow(CSV_FIELDS)
            return self.respond(200,raw=('\ufeff'+output.getvalue()).encode('utf-8'),content_type='text/csv; charset=utf-8',extra={'Content-Disposition':'attachment; filename="gear-import-template.csv"'})
        if parts == ['api','audit']:
            try:
                limit=min(100,max(1,int(query.get('limit',['30'])[0])))
                conditions=[]; args=[]
                for key,column in [('item_id','a.item_id'),('before','a.id')]:
                    if key in query:
                        value=int(query[key][0])
                        if value<1: raise ValueError('Érvénytelen azonosító')
                        conditions.append(column+(' < ?' if key=='before' else ' = ?'));args.append(value)
                where=' WHERE '+' AND '.join(conditions) if conditions else ''
                with connect() as db:
                    rows=db.execute('SELECT a.*, EXISTS(SELECT 1 FROM items i WHERE i.id=a.item_id) AS item_exists FROM audit_log a'+where+' ORDER BY a.id DESC LIMIT ?',(*args,limit+1)).fetchall()
                entries=[dict(row) for row in rows[:limit]]
                for entry in entries: entry['changes']=json.loads(entry['changes'])
                return self.respond(200,{'entries':entries,'next_before':entries[-1]['id'] if len(rows)>limit else None})
            except (ValueError,TypeError): return self.respond(400,{'error':'Érvénytelen naplószűrő'})
        if parts == ['api','items']:
            q = query.get('q',[''])[0].strip()
            with connect() as db:
                if q:
                    like = '%' + q.replace('%','\\%').replace('_','\\_') + '%'
                    rows = db.execute("SELECT * FROM items WHERE (name LIKE ? ESCAPE '\\' OR brand LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR serial LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\') ORDER BY updated_at DESC,id DESC",(like,)*5).fetchall()
                else: rows = db.execute('SELECT * FROM items ORDER BY updated_at DESC,id DESC').fetchall()
            return self.respond(200,[dict(r) for r in rows])
        if len(parts)==3 and parts[:2]==['api','items'] and parts[2].isdigit():
            with connect() as db:
                item=db.execute('SELECT * FROM items WHERE id=?',(int(parts[2]),)).fetchone()
                if not item: return self.respond(404,{'error':'Nem található'})
                events=db.execute('SELECT * FROM events WHERE item_id=? ORDER BY happened DESC,id DESC',(item['id'],)).fetchall()
                files=db.execute('SELECT id,filename,mime,created_at FROM attachments WHERE item_id=? ORDER BY id DESC',(item['id'],)).fetchall()
            return self.respond(200,{'item':dict(item),'events':[dict(e) for e in events],'attachments':[dict(f) for f in files]})
        if len(parts)==2 and parts[0]=='uploads' and parts[1].isdigit():
            with connect() as db: row=db.execute('SELECT stored,mime FROM attachments WHERE id=?',(int(parts[1]),)).fetchone()
            if not row: return self.respond(404,{'error':'Nem található'})
            return self.respond(200,raw=(DATA/'uploads'/row['stored']).read_bytes(),content_type=row['mime'])
        if parts in ([],['index.html']): filename='index.html'
        elif len(parts)==1 and parts[0] in ('app.js','i18n.js','translations.json','sorting.js','style.css'): filename=parts[0]
        else: return self.respond(404,{'error':'Nem található'})
        mime={'i18n.js':'application/javascript; charset=utf-8','translations.json':'application/json; charset=utf-8','index.html':'text/html; charset=utf-8','app.js':'application/javascript; charset=utf-8','sorting.js':'application/javascript; charset=utf-8','style.css':'text/css; charset=utf-8'}[filename]
        return self.respond(200,raw=(BASE/filename).read_bytes(),content_type=mime)

    def do_POST(self):
        parts,_=self.route()
        try:
            if parts==['api','login']:
                data=self.payload()
                if not PASSWORD or not hmac.compare_digest(str(data.get('password','')).encode('utf-8'),PASSWORD.encode('utf-8')):
                    return self.respond(401,{'error':'Hibás jelszó'})
                expiry=str(int(time.time())+86400*30)
                sig=hmac.new(SECRET,expiry.encode(),hashlib.sha256).hexdigest()
                return self.respond(200,{'ok':True},extra={'Set-Cookie':f'gear_session={expiry}.{sig}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'+('; Secure' if COOKIE_SECURE else '')})
            if not self.auth(): return self.respond(401,{'error':'Bejelentkezés szükséges'})
            if parts==['api','logout']:
                return self.respond(200,{'ok':True},extra={'Set-Cookie':'gear_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+('; Secure' if COOKIE_SECURE else '')})
            if parts in (['api','import','preview'],['api','import','commit']):
                data=self.payload(6_000_000)
                mode=data.get('mode','abort')
                if mode not in ('abort','skip'): raise ValueError('Érvénytelen importmód')
                with connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    preview=csv_preview(db,data.get('csv'))
                    if parts[-1]=='preview': return self.respond(200,preview)
                    if preview['invalid'] and mode=='abort':
                        return self.respond(409,{'error':'Hibás sorok: az import nem történt meg. Frissítsd az előnézetet.','preview':preview})
                    batch_id=secrets.token_hex(12);ids=[]
                    for row in preview['rows']:
                        if row['errors']: continue
                        item=row['item'];item['id']=next_item_id(db)
                        db.execute('INSERT INTO items (id,'+','.join(FIELDS)+') VALUES ('+','.join('?' for _ in range(len(FIELDS)+1))+')',(item['id'],*[item[k] for k in FIELDS]))
                        audit(db,item,'import',{key:{'old':None,'new':item[key]} for key in FIELDS},batch_id)
                        db.execute('INSERT INTO events (item_id,kind,title,details) VALUES (?,?,?,?)',(item['id'],'Állapot','CSV importtal felvéve',item['status']))
                        ids.append(item['id'])
                return self.respond(201,{'imported':len(ids),'skipped':preview['invalid'],'ids':ids,'batch_id':batch_id})
            if parts==['api','items']:
                data=self.payload()
                values=self.item_values(data)
                with connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    item_id=next_item_id(db)
                    db.execute('INSERT INTO items (id,'+','.join(FIELDS)+') VALUES ('+','.join('?' for _ in range(len(FIELDS)+1))+')',(item_id,*values))
                    item=dict(zip(FIELDS,values));item['id']=item_id
                    audit(db,item,'create',{key:{'old':None,'new':item[key]} for key in FIELDS})
                    db.execute('INSERT INTO events (item_id,kind,title,details) VALUES (?,?,?,?)',(item_id,'Állapot','Felvéve a nyilvántartásba',item['status']))
                return self.respond(201,{'id':item_id})
            if parts==['api','items','bulk']:
                data=self.payload()
                ids=data.get('ids'); changes=data.get('changes')
                if not isinstance(ids,list) or not 1<=len(ids)<=500 or any(type(i) is not int or i<1 for i in ids):
                    raise ValueError('1–500 érvényes eszközazonosító szükséges')
                ids=list(dict.fromkeys(ids))
                if not isinstance(changes,dict) or not changes or any(key not in BULK_FIELDS for key in changes):
                    raise ValueError('Válassz módosítható mezőket')
                limits={'acquisition_type':80,'status':80,'category':80,'location':120,'brand':100,'model':120,'acquired':30,'price':80,'notes':10000}
                if any(not isinstance(value,str) or len(value)>limits[key] for key,value in changes.items()):
                    raise ValueError('Érvénytelen vagy túl hosszú mezőérték')
                if any(key in changes and not changes[key].strip() for key in ('status','category')):
                    raise ValueError('Az állapot és kategória nem lehet üres')
                if 'acquisition_type' in changes: changes['acquisition_type']=acquisition_type(changes['acquisition_type'])
                batch_id=secrets.token_hex(12)
                with connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    rows=db.execute('SELECT * FROM items WHERE id IN ('+','.join('?' for _ in ids)+')',ids).fetchall()
                    if len(rows)!=len(ids): raise ValueError('Egy kijelölt eszköz már nem található. Frissítsd a listát.')
                    updated=sum(update_item(db,row,changes,'bulk_update',batch_id) for row in rows)
                return self.respond(200,{'updated':updated,'selected':len(ids),'batch_id':batch_id})
            if len(parts)==4 and parts[:2]==['api','items'] and parts[2].isdigit() and parts[3]=='events':
                item_id=int(parts[2]); data=self.payload()
                kind=str(data.get('kind',''))[:60]; title=str(data.get('title','')).strip()[:200]
                if kind not in KINDS or not title: raise ValueError('Típus és cím szükséges')
                happened=str(data.get('happened',''))[:10] or time.strftime('%Y-%m-%d')
                details=str(data.get('details',''))[:10000]
                with connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    item=db.execute('SELECT * FROM items WHERE id=?',(item_id,)).fetchone()
                    if not item: return self.respond(404,{'error':'Nem található'})
                    db.execute('INSERT INTO events (item_id,kind,happened,title,details) VALUES (?,?,?,?,?)',(item_id,kind,happened,title,details))
                    audit(db,item,'event',{'event':{'old':None,'new':{'kind':kind,'happened':happened,'title':title,'details':details}}})
                return self.respond(201,{'ok':True})
            if len(parts)==4 and parts[:2]==['api','items'] and parts[2].isdigit() and parts[3]=='attachments':
                item_id=int(parts[2]); data=self.payload(11_000_000)
                name=Path(str(data.get('filename','file'))).name[:150]
                ext=Path(name).suffix.lower()
                if ext not in ('.jpg','.jpeg','.png','.webp','.gif','.pdf','.txt'): raise ValueError('Csak kép, PDF vagy TXT tölthető fel')
                binary=base64.b64decode(data.get('content',''),validate=True)
                if len(binary)>7_000_000: raise ValueError('A fájl maximum 7 MB lehet')
                mime={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.pdf':'application/pdf','.txt':'text/plain; charset=utf-8'}[ext]
                stored=secrets.token_hex(20)+ext
                with connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    item=db.execute('SELECT * FROM items WHERE id=?',(item_id,)).fetchone()
                    if not item: return self.respond(404,{'error':'Nem található'})
                    (DATA/'uploads'/stored).write_bytes(binary)
                    db.execute('INSERT INTO attachments (item_id,filename,stored,mime) VALUES (?,?,?,?)',(item_id,name,stored,mime))
                    audit(db,item,'attachment',{'filename':{'old':None,'new':name}})
                return self.respond(201,{'ok':True})
            return self.respond(404,{'error':'Nem található'})
        except (ValueError,TypeError,KeyError,sqlite3.IntegrityError) as exc:
            return self.respond(400,{'error':'Érvénytelen adat vagy hivatkozás' if isinstance(exc,sqlite3.IntegrityError) else 'Érvénytelen JSON' if isinstance(exc,(json.JSONDecodeError,UnicodeError)) else public_error(exc)})

    def item_values(self,data):
        name=str(data.get('name','')).strip()[:200]
        if not name: raise ValueError('Név szükséges')
        parent=data.get('parent_id') or None
        if parent is not None: parent=int(parent)
        return (name, str(data.get('category','Egyéb'))[:80],str(data.get('brand',''))[:100],str(data.get('model',''))[:120],str(data.get('serial',''))[:120],str(data.get('status','Aktív'))[:80],str(data.get('location',''))[:120],str(data.get('acquired',''))[:30],str(data.get('price',''))[:80],acquisition_type(data.get('acquisition_type','')),str(data.get('notes',''))[:10000],parent)

    def do_PUT(self):
        parts,_=self.route()
        if not self.auth(): return self.respond(401,{'error':'Bejelentkezés szükséges'})
        if len(parts)!=3 or parts[:2]!=['api','items'] or not parts[2].isdigit(): return self.respond(404,{'error':'Nem található'})
        item_id=int(parts[2])
        try:
            data=self.payload()
            with connect() as db:
                db.execute('BEGIN IMMEDIATE')
                old=db.execute('SELECT * FROM items WHERE id=?',(item_id,)).fetchone()
                if not old: return self.respond(404,{'error':'Nem található'})
                if 'acquisition_type' not in data: data['acquisition_type']=old['acquisition_type']
                values=self.item_values(data)
                if values[-1]==item_id: raise ValueError('Eszköz nem lehet a saját szülője')
                update_item(db,old,dict(zip(FIELDS,values)))
            return self.respond(200,{'ok':True})
        except (ValueError,TypeError,sqlite3.IntegrityError) as exc: return self.respond(400,{'error':'Érvénytelen adat vagy hivatkozás' if isinstance(exc,sqlite3.IntegrityError) else 'Érvénytelen JSON' if isinstance(exc,(json.JSONDecodeError,UnicodeError)) else public_error(exc)})

    def do_DELETE(self):
        parts,_=self.route()
        if not self.auth(): return self.respond(401,{'error':'Bejelentkezés szükséges'})
        if len(parts)!=3 or parts[:2]!=['api','items'] or not parts[2].isdigit():
            return self.respond(404,{'error':'Nem található'})
        item_id=int(parts[2])
        with connect() as db:
            # Serialize against concurrent attachment uploads before collecting filenames.
            db.execute('BEGIN IMMEDIATE')
            item=db.execute('SELECT * FROM items WHERE id=?',(item_id,)).fetchone()
            if not item:
                return self.respond(404,{'error':'Nem található'})
            files=db.execute('SELECT stored FROM attachments WHERE item_id=?',(item_id,)).fetchall()
            audit(db,item,'delete',{key:{'old':item[key],'new':None} for key in FIELDS})
            for child in db.execute('SELECT * FROM items WHERE parent_id=?',(item_id,)).fetchall():
                update_item(db,child,{'parent_id':None},'detach')
            # Foreign keys remove events/attachment records and detach child components.
            db.execute('DELETE FROM items WHERE id=?',(item_id,))
        for file in files:
            try: (DATA/'uploads'/Path(file['stored']).name).unlink(missing_ok=True)
            except OSError: self.log_message('Attachment cleanup failed for deleted item %s',item_id)
        return self.respond(200,{'ok':True})

    def log_message(self, fmt,*args):
        print('%s - %s' % (self.address_string(), fmt%args),flush=True)

if __name__=='__main__':
    if not PASSWORD: raise SystemExit('GEAR_PASSWORD environment variable is required')
    ThreadingHTTPServer(('0.0.0.0',int(os.getenv('PORT','8080'))),Handler).serve_forever()
