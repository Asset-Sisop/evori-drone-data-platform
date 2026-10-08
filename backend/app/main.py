from fastapi import FastAPI, UploadFile, File, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from jose import jwt, JWTError
from passlib.context import CryptContext
import sqlite3, uuid, shutil, os, json

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'storage'; DATA.mkdir(exist_ok=True)
DB = ROOT / 'evori.db'
SECRET = os.getenv('EVORI_SECRET', 'change-me-in-production')
ALGO='HS256'; pwd=CryptContext(schemes=['bcrypt'], deprecated='auto'); oauth=OAuth2PasswordBearer(tokenUrl='/api/auth/login')
app=FastAPI(title='EVORI Drone Data Platform API', version='1.0.0')
app.add_middleware(CORSMiddleware, allow_origins=['http://localhost:5173','http://localhost:3000'], allow_credentials=True, allow_methods=['*'], allow_headers=['*'])

class ProjectIn(BaseModel):
    title:str=Field(min_length=1); customer:str=''; location:str=''; survey_date:date|None=None; object_type:str='другой объект'; description:str=''; status:str='Создан'
class MeasureIn(BaseModel):
    kind:str; value:float; unit:str; geometry:dict|None=None; comment:str=''

def conn():
    c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; return c

def init_db():
    c=conn(); c.executescript('''CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, hashed_password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, owner_id INTEGER, title TEXT, customer TEXT, location TEXT, survey_date TEXT, object_type TEXT, description TEXT, status TEXT, created_at TEXT, FOREIGN KEY(owner_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, project_id TEXT, filename TEXT, stored_path TEXT, file_type TEXT, size INTEGER, is_result INTEGER DEFAULT 0, created_at TEXT, FOREIGN KEY(project_id) REFERENCES projects(id));
    CREATE TABLE IF NOT EXISTS measurements(id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, value REAL, unit TEXT, geometry TEXT, comment TEXT, created_at TEXT, FOREIGN KEY(project_id) REFERENCES projects(id));''')
    if not c.execute('SELECT 1 FROM users LIMIT 1').fetchone(): c.execute('INSERT INTO users(username,hashed_password) VALUES(?,?)',('demo',pwd.hash('demo123')))
    c.commit(); c.close()
init_db()

def token(user): return jwt.encode({'sub':str(user['id']),'exp':datetime.now(timezone.utc)+timedelta(hours=8)},SECRET,algorithm=ALGO)
def current(token_str=Depends(oauth)):
    try: p=jwt.decode(token_str,SECRET,algorithms=[ALGO]); uid=int(p['sub'])
    except (JWTError,ValueError): raise HTTPException(401,'Недействительный токен')
    c=conn(); u=c.execute('SELECT * FROM users WHERE id=?',(uid,)).fetchone(); c.close()
    if not u: raise HTTPException(401,'Пользователь не найден')
    return u

def project_or_404(pid,user):
    c=conn(); p=c.execute('SELECT * FROM projects WHERE id=? AND owner_id=?',(pid,user['id'])).fetchone(); c.close()
    if not p: raise HTTPException(404,'Проект не найден')
    return p

@app.get('/api/health')
def health(): return {'status':'ok','service':'evori-api','version':'1.0.0'}

@app.post('/api/auth/login')
def login(form:OAuth2PasswordRequestForm=Depends()):
    c=conn(); u=c.execute('SELECT * FROM users WHERE username=?',(form.username,)).fetchone(); c.close()
    if not u or not pwd.verify(form.password,u['hashed_password']): raise HTTPException(401,'Неверный логин или пароль')
    return {'access_token':token(u),'token_type':'bearer','username':u['username']}

@app.get('/api/auth/me')
def me(u=Depends(current)): return {'id':u['id'],'username':u['username']}

@app.get('/api/projects')
def list_projects(u=Depends(current)):
    c=conn(); rows=c.execute('SELECT * FROM projects WHERE owner_id=? ORDER BY created_at DESC',(u['id'],)).fetchall(); c.close(); return [dict(r) for r in rows]

@app.post('/api/projects')
def create_project(data:ProjectIn,u=Depends(current)):
    pid=str(uuid.uuid4()); now=datetime.now(timezone.utc).isoformat(); sd=data.survey_date.isoformat() if data.survey_date else None
    c=conn(); c.execute('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?,?)',(pid,u['id'],data.title,data.customer,data.location,sd,data.object_type,data.description,data.status,now)); c.commit(); c.close(); return {'id':pid,**data.model_dump(), 'survey_date':sd,'created_at':now}

@app.get('/api/projects/{pid}')
def get_project(pid:str,u=Depends(current)):
    p=project_or_404(pid,u); c=conn(); files=[dict(x) for x in c.execute('SELECT * FROM files WHERE project_id=? ORDER BY created_at DESC',(pid,)).fetchall()]; ms=[dict(x) for x in c.execute('SELECT * FROM measurements WHERE project_id=? ORDER BY created_at',(pid,)).fetchall()]; c.close();
    for m in ms: m['geometry']=json.loads(m['geometry']) if m['geometry'] else None
    return {'project':dict(p),'files':files,'measurements':ms}

@app.post('/api/projects/{pid}/files')
async def upload(pid:str, file:UploadFile=File(...), result:bool=False, u=Depends(current)):
    project_or_404(pid,u); allowed={'.jpg','.jpeg','.png','.tif','.tiff','.zip','.csv','.geojson','.json','.las','.laz','.obj'}; ext=Path(file.filename or '').suffix.lower()
    if ext not in allowed: raise HTTPException(400,f'Неподдерживаемый формат: {ext}')
    fid=str(uuid.uuid4()); target=DATA/f'{fid}_{Path(file.filename).name}'; size=0
    with target.open('wb') as out:
        while chunk:=await file.read(1024*1024): out.write(chunk); size+=len(chunk)
    now=datetime.now(timezone.utc).isoformat(); c=conn(); c.execute('INSERT INTO files VALUES(?,?,?,?,?,?,?,?)',(fid,pid,file.filename,str(target),ext.lstrip('.'),size,1 if result else 0,now)); c.execute("UPDATE projects SET status=? WHERE id=?",('Завершен' if result else 'В обработке',pid)); c.commit(); c.close()
    return {'id':fid,'filename':file.filename,'size':size,'file_type':ext.lstrip('.'),'is_result':result,'created_at':now}

@app.post('/api/import/result')
async def import_result(project_id:str, file:UploadFile=File(...), u=Depends(current)):
    # Automated scenario V: an already processed result is imported and attached to a selected project.
    return await upload(project_id,file,True,u)

@app.get('/api/files/{fid}')
def download_file(fid:str,u=Depends(current)):
    c=conn(); f=c.execute('''SELECT f.* FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=? AND p.owner_id=?''',(fid,u['id'])).fetchone(); c.close()
    if not f: raise HTTPException(404,'Файл не найден');
    return FileResponse(f['stored_path'],filename=f['filename'])

@app.post('/api/projects/{pid}/measurements')
def add_measurement(pid:str,data:MeasureIn,u=Depends(current)):
    project_or_404(pid,u); mid=str(uuid.uuid4()); now=datetime.now(timezone.utc).isoformat(); c=conn(); c.execute('INSERT INTO measurements VALUES(?,?,?,?,?,?,?,?)',(mid,pid,data.kind,data.value,data.unit,json.dumps(data.geometry) if data.geometry else None,data.comment,now)); c.commit(); c.close(); return {'id':mid,**data.model_dump(),'created_at':now}

@app.get('/api/projects/{pid}/report')
def report(pid:str,u=Depends(current)):
    p=project_or_404(pid,u); c=conn(); ms=c.execute('SELECT kind,value,unit,comment FROM measurements WHERE project_id=?',(pid,)).fetchall(); c.close()
    html=f'''<!doctype html><html><head><meta charset="utf-8"><title>EVORI — {p['title']}</title><style>body{{font-family:Arial;margin:40px}}h1{{margin-bottom:8px}}table{{border-collapse:collapse;width:100%}}td,th{{border:1px solid #ddd;padding:8px}}</style></head><body><h1>EVORI Drone Data Platform</h1><h2>{p['title']}</h2><p><b>Заказчик:</b> {p['customer']}<br><b>Местоположение:</b> {p['location']}<br><b>Дата:</b> {p['survey_date'] or ''}<br><b>Тип объекта:</b> {p['object_type']}</p><p>{p['description'] or ''}</p><h3>Измерения</h3><table><tr><th>Тип</th><th>Значение</th><th>Ед.</th><th>Комментарий</th></tr>{''.join(f"<tr><td>{m['kind']}</td><td>{m['value']:.2f}</td><td>{m['unit']}</td><td>{m['comment'] or ''}</td></tr>" for m in ms) or '<tr><td colspan=4>Нет измерений</td></tr>'}</table><p>Отчёт сформирован: {datetime.now().strftime('%Y-%m-%d %H:%M')}</p></body></html>'''
    out=DATA/f'report_{pid}.html'; out.write_text(html,encoding='utf-8'); return FileResponse(out,media_type='text/html',filename=f'EVORI_{p["title"]}.html')
