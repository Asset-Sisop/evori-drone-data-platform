import React,{useEffect,useMemo,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MapContainer,TileLayer,FeatureGroup,GeoJSON,ImageOverlay,useMap,useMapEvents} from 'react-leaflet';
import {EditControl} from 'react-leaflet-draw';
import L from 'leaflet';
import {fromArrayBuffer} from 'geotiff';
import proj4 from 'proj4';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';
import './style.css';

const API=import.meta.env.VITE_API_URL||'http://localhost:8000/api';
const auth=()=>({Authorization:'Bearer '+localStorage.token});

function Login({onLogin}){
 const [u,setU]=useState('demo'),[p,setP]=useState('demo123'),[e,setE]=useState(''),[busy,setBusy]=useState(false);
 async function go(ev){ev.preventDefault();setBusy(true);setE('');try{
  const form=new URLSearchParams({username:u,password:p});
  const r=await fetch(API+'/auth/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});
  const d=await r.json();if(!r.ok)throw new Error(d.detail||'Ошибка авторизации');
  localStorage.token=d.access_token;onLogin();
 }catch(x){setE(x.message)}finally{setBusy(false)}}
 return <div className="login"><div className="card"><h1>EVORI</h1><p>Drone Data Platform</p><form onSubmit={go}>
  <input value={u} onChange={e=>setU(e.target.value)} placeholder="Логин" autoComplete="username"/>
  <input type="password" value={p} onChange={e=>setP(e.target.value)} placeholder="Пароль" autoComplete="current-password"/>
  <button disabled={busy}>{busy?'Вход…':'Войти'}</button></form><small>Демо: demo / demo123</small>{e&&<div className="error">{e}</div>}</div></div>
}

function ResultLayer({files}){
 const map=useMap(),[geo,setGeo]=useState([]),[rasters,setRasters]=useState([]),[error,setError]=useState('');
 const results=useMemo(()=>files.filter(f=>f.is_result),[files]);
 useEffect(()=>{let cancelled=false;
  async function load(){
   setGeo([]);setRasters([]);setError('');if(!results.length)return;
   const g=[],r=[];
   for(const file of results){const ext='.'+(file.file_type||'').toLowerCase();try{
    const response=await fetch(API+'/files/'+file.id,{headers:auth()});if(!response.ok)throw new Error(file.filename+': HTTP '+response.status);
    if(ext==='.geojson'||ext==='.json'){g.push({id:file.id,data:await response.json()});continue}
    if(ext!=='.tif'&&ext!=='.tiff')continue;
    const image=await (await fromArrayBuffer(await response.arrayBuffer())).getImage(0);
    const width=image.getWidth(),height=image.getHeight(),scale=Math.min(1,1600/Math.max(width,height));
    const outW=Math.max(1,Math.round(width*scale)),outH=Math.max(1,Math.round(height*scale));
    const data=await image.readRasters({interleave:true,width:outW,height:outH});
    const samples=image.getSamplesPerPixel(),pixels=new Uint8ClampedArray(outW*outH*4);
    let max=255;for(let i=0;i<data.length;i++)if(data[i]>max)max=data[i];const div=max>255?max/255:1;
    for(let i=0;i<outW*outH;i++){const s=i*samples,v=n=>Math.max(0,Math.min(255,Math.round(data[s+n]/div)));
      if(samples>=3){pixels[i*4]=v(0);pixels[i*4+1]=v(1);pixels[i*4+2]=v(2)}else{pixels[i*4]=v(0);pixels[i*4+1]=v(0);pixels[i*4+2]=v(0)}
      pixels[i*4+3]=samples>=4?v(3):230;
    }
    const canvas=document.createElement('canvas');canvas.width=outW;canvas.height=outH;canvas.getContext('2d').putImageData(new ImageData(pixels,outW,outH),0,0);
    const bbox=image.getBoundingBox(),keys=image.getGeoKeys?.()||{},epsg=keys.ProjectedCSTypeGeoKey||keys.GeographicTypeGeoKey||4326;
    const toWgs84=xy=>{if(Number(epsg)===4326)return xy;if(Number(epsg)===3857){const x=xy[0],y=xy[1];return [x/6378137*180/Math.PI,(2*Math.atan(Math.exp(y/6378137))-Math.PI/2)*180/Math.PI]}if(String(epsg).startsWith('326')||String(epsg).startsWith('327'))return proj4('EPSG:'+epsg,'EPSG:4326',xy);throw new Error('Неподдерживаемая CRS EPSG:'+epsg)};
    const sw=toWgs84([bbox[0],bbox[1]]),ne=toWgs84([bbox[2],bbox[3]]);
    r.push({id:file.id,url:canvas.toDataURL('image/png'),bounds:[[sw[1],sw[0]],[ne[1],ne[0]]]});
   }catch(x){setError(prev=>prev||('Не удалось отобразить '+file.filename+': '+x.message))}}
   if(cancelled)return;setGeo(g);setRasters(r);
   const bounds=[];r.forEach(x=>bounds.push(...x.bounds));g.forEach(x=>{try{const layer=L.geoJSON(x.data);if(layer.getBounds().isValid())bounds.push(layer.getBounds().getSouthWest(),layer.getBounds().getNorthEast())}catch{}});
   if(bounds.length)map.fitBounds(bounds,{padding:[20,20]});
  }load();return()=>{cancelled=true};
 },[results,map]);
 return <>{geo.map(x=><GeoJSON key={x.id} data={x.data}/>)}{rasters.map(x=><ImageOverlay key={x.id} url={x.url} bounds={x.bounds} opacity={0.72}/>)}{error&&<div className="map-error">{error}</div>}</>
}

function DrawTools({measurements,setMeasurements}){
 useMapEvents({});
 return <FeatureGroup><EditControl position="topright" draw={{polyline:true,polygon:true,rectangle:false,circle:false,marker:false,circlemarker:false}} edit={{remove:true}}
  onCreated={ev=>{const layer=ev.layer,kind=ev.layerType==='polygon'?'Площадь':'Расстояние';
   const value=ev.layerType==='polygon'?L.GeometryUtil.geodesicArea(layer.getLatLngs()[0]):layer.getLatLngs().reduce((s,p,i,a)=>i?s+mapDist(a[i-1],p):0,0);
   setMeasurements(cur=>[...cur,{kind,value,unit:ev.layerType==='polygon'?'м²':'м',geometry:layer.toGeoJSON?.().geometry||null,comment:''}]);
  }}/></FeatureGroup>
}
function mapDist(a,b){const R=6371000,rad=x=>x*Math.PI/180,dLat=rad(b.lat-a.lat),dLon=rad(b.lng-a.lng),q=Math.sin(dLat/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLon/2)**2;return 2*R*Math.asin(Math.sqrt(q))}
function MapView({files,measurements,setMeasurements}){return <MapContainer center={[51.16,71.47]} zoom={10} className="map"><TileLayer attribution="© OpenStreetMap contributors" url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/><ResultLayer files={files}/><DrawTools measurements={measurements} setMeasurements={setMeasurements}/></MapContainer>}

function App(){
 const [logged,setLogged]=useState(!!localStorage.token),[projects,setProjects]=useState([]),[selected,setSelected]=useState(null),[files,setFiles]=useState([]),[measurements,setMeasurements]=useState([]),[show,setShow]=useState(false),[notice,setNotice]=useState('');
 const [form,setForm]=useState({title:'',customer:'',location:'',survey_date:'',object_type:'карьер',description:''});
 async function load(){const r=await fetch(API+'/projects',{headers:auth()});if(r.status===401)return logout();setProjects(await r.json())}
 useEffect(()=>{if(logged)load()},[logged]);
 function logout(){localStorage.removeItem('token');setLogged(false);setSelected(null)}
 async function open(id){const r=await fetch(API+'/projects/'+id,{headers:auth()});if(r.status===401)return logout();const d=await r.json();setSelected(d.project);setFiles(d.files||[]);setMeasurements(d.measurements||[]);setNotice('')}
 async function create(ev){ev.preventDefault();const r=await fetch(API+'/projects',{method:'POST',headers:{...auth(),'Content-Type':'application/json'},body:JSON.stringify(form)}),d=await r.json();if(!r.ok)return setNotice(d.detail||'Не удалось создать проект');setShow(false);setForm({title:'',customer:'',location:'',survey_date:'',object_type:'карьер',description:''});await load();await open(d.id)}
 async function upload(ev,result=false){const file=ev.target.files?.[0];ev.target.value='';if(!file||!selected)return;const fd=new FormData();fd.append('file',file);const url=result?API+'/import/result?project_id='+encodeURIComponent(selected.id):API+'/projects/'+selected.id+'/files';const r=await fetch(url,{method:'POST',headers:auth(),body:fd}),d=await r.json().catch(()=>({}));if(!r.ok)return setNotice(d.detail||'Не удалось загрузить файл');setNotice((result?'Результат импортирован: ':'Файл загружен: ')+file.name);await open(selected.id);await load()}
 async function saveMs(){const pending=measurements.filter(m=>!m.id);if(!pending.length)return setNotice('Новых измерений для сохранения нет.');for(const m of pending){const r=await fetch(API+'/projects/'+selected.id+'/measurements',{method:'POST',headers:{...auth(),'Content-Type':'application/json'},body:JSON.stringify(m)});if(!r.ok)return setNotice('Не удалось сохранить измерение.')}await open(selected.id);setNotice('Сохранено измерений: '+pending.length)}
 async function report(){setNotice('Формирую отчёт…');const r=await fetch(API+'/projects/'+selected.id+'/report',{headers:auth()});if(!r.ok)return setNotice('Не удалось сформировать отчёт.');const url=URL.createObjectURL(await r.blob());window.open(url,'_blank','noopener,noreferrer');setTimeout(()=>URL.revokeObjectURL(url),60000);setNotice('Отчёт открыт. Для PDF используйте печать браузера.')}
 if(!logged)return <Login onLogin={()=>setLogged(true)}/>;
 return <div className="app"><header><b>EVORI</b><span>Drone Data Platform</span><button onClick={logout}>Выйти</button></header>
  <aside><div className="sidehead"><h2>Проекты</h2><button onClick={()=>setShow(true)}>+ Новый</button></div>{projects.map(p=><div className={'project '+(selected?.id===p.id?'active':'')} onClick={()=>open(p.id)} key={p.id}><b>{p.title}</b><small>{p.customer||'Без заказчика'} · {p.status}</small></div>)}{!projects.length&&<div className="empty-side">Проектов пока нет.</div>}</aside>
  <main>{!selected?<div className="empty"><h2>Выберите проект</h2><p>Создайте проект, загрузите данные и откройте карту.</p></div>:<><div className="toolbar"><div><h1>{selected.title}</h1><span>{selected.location||'Местоположение не указано'} · {selected.object_type}</span></div>
   <label className="upload">Загрузить данные<input type="file" accept=".jpg,.jpeg,.png,.tif,.tiff,.zip,.csv,.geojson,.json" onChange={e=>upload(e,false)}/></label>
   <label className="upload result">Импорт результата<input type="file" accept=".tif,.tiff,.geojson,.json" onChange={e=>upload(e,true)}/></label><button onClick={saveMs}>Сохранить измерения</button><button className="button" onClick={report}>Отчёт</button></div>
   {notice&&<div className="notice">{notice}</div>}<MapView files={files} measurements={measurements} setMeasurements={setMeasurements}/>
   <div className="measurements"><b>Измерения:</b>{measurements.length?measurements.map((m,i)=><span key={m.id||i}>{m.kind}: {Number(m.value).toFixed(2)} {m.unit}{m.id?' ✓':' · новое'}</span>):<em> нарисуйте линию или полигон на карте</em>}</div>
   <div className="files"><b>Результаты:</b>{files.filter(f=>f.is_result).length?files.filter(f=>f.is_result).map(f=><span key={f.id}>{f.filename}</span>):<em> импортируйте GeoTIFF или GeoJSON</em>}</div>
  </>}</main>
  {show&&<div className="modal"><form onSubmit={create} className="card"><h2>Новый проект</h2>{[['title','Название'],['customer','Заказчик'],['location','Местоположение'],['survey_date','Дата обследования'],['description','Описание']].map(([k,l])=><input key={k} type={k==='survey_date'?'date':'text'} placeholder={l} value={form[k]} onChange={e=>setForm({...form,[k]:e.target.value})} required={k==='title'}/>)}<select value={form.object_type} onChange={e=>setForm({...form,object_type:e.target.value})}>{['карьер','строительный объект','дорога','промышленный объект','территория','сельскохозяйственный участок','другой объект'].map(x=><option key={x}>{x}</option>)}</select><button>Создать</button><button type="button" onClick={()=>setShow(false)}>Отмена</button></form></div>}</div>
}
createRoot(document.getElementById('root')).render(<App/>);