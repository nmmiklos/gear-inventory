"""Add fictional demo items explicitly. Never run automatically or overwrite existing records."""
from app import connect, next_item_id, audit, FIELDS

ITEMS = [
    {'name':'Demo laptop','category':'Laptop','brand':'Example','model':'Demo 1','status':'Tárolva',
     'acquisition_type':'Vásárolt','notes':'Fictional example. Replace with your own equipment.'},
    {'name':'Demo monitor','category':'Monitor','brand':'Example','model':'Demo 2','status':'Tárolva',
     'acquisition_type':'Ismeretlen','notes':'Fictional example; no personal information.'},
]

def main():
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        added=0
        for sample in ITEMS:
            if db.execute('SELECT 1 FROM items WHERE name=?',(sample['name'],)).fetchone(): continue
            item={key:sample.get(key,None if key=='parent_id' else '') for key in FIELDS}
            item['id']=next_item_id(db)
            db.execute('INSERT INTO items (id,'+','.join(FIELDS)+') VALUES ('+','.join('?' for _ in range(len(FIELDS)+1))+')',
                       (item['id'],*[item[key] for key in FIELDS]))
            audit(db,item,'create',{key:{'old':None,'new':item[key]} for key in FIELDS})
            added+=1
    print(f'{added} demo items added; existing items were not changed.')

if __name__=='__main__': main()
