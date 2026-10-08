from fastapi.testclient import TestClient
from app.main import app
client=TestClient(app)
def test_health(): assert client.get('/api/health').json()['status']=='ok'
def test_login():
 r=client.post('/api/auth/login',data={'username':'demo','password':'demo123'}); assert r.status_code==200 and 'access_token' in r.json()