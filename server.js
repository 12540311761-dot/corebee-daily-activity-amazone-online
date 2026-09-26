const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_MJA_BERLIAN_SECRET';
const APP_VERSION = process.env.APP_VERSION || '2.1.0-free';
const APP_URL = process.env.APP_URL || '/';
const DATABASE_URL = process.env.DATABASE_URL || '';
const TEAMS = ['Kaizen','Gladiator','Semesta','Forge'];

if (!DATABASE_URL) {
  console.error('DATABASE_URL belum diisi. Versi gratis ini memakai PostgreSQL online agar data tidak hilang saat hosting restart.');
}

const pool = new Pool({
  connectionString: DATABASE_URL || undefined,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const now = () => new Date().toISOString();

async function q(text, params=[]) {
  return pool.query(text, params);
}

async function initDb() {
  if (!DATABASE_URL) throw new Error('DATABASE_URL wajib diisi');
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      team TEXT,
      password_hash TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(name, role, team)
    );
    CREATE TABLE IF NOT EXISTS team_states (
      team TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const seedPw = { Kaizen:'KAIZEN90', Gladiator:'GLADIATOR90', Semesta:'SEMESTA90', Forge:'FORGE90' };
  for (const team of TEAMS) {
    const exists = await q('SELECT id FROM users WHERE role=$1 AND team=$2 LIMIT 1', ['A1 Team', team]);
    if (!exists.rows[0]) {
      await q('INSERT INTO users(name,role,team,password_hash,created_at) VALUES($1,$2,$3,$4,$5)',
        ['Bpk. Feri Kusmanto','A1 Team',team,bcrypt.hashSync(seedPw[team],10),now()]);
    }
    const state = await q('SELECT team FROM team_states WHERE team=$1', [team]);
    if (!state.rows[0]) {
      const blank = {
        profile:{teamName:team,leaderName:'',phone:'',fullName:'',email:'',note:'',photo:'',album:[]},
        a1Profile:{teamName:team,fullName:'Bpk. Feri Kusmanto',phone:'',email:'',note:'',photo:'',album:[]},
        target:{closing:5,tj:5,tf:5},records:[],a1_records:[],kas:[],mitra:[],po:[]
      };
      await q('INSERT INTO team_states(team,state_json,updated_at,updated_by) VALUES($1,$2,$3,$4)',
        [team,JSON.stringify(blank),now(),'system']);
    }
  }
  await q(`INSERT INTO app_meta(key,value) VALUES($1,$2)
            ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, ['version',APP_VERSION]);
  await q(`INSERT INTO app_meta(key,value) VALUES($1,$2)
            ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, ['app_url',APP_URL]);
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

function tokenFor(user) {
  return jwt.sign({id:user.id,name:user.name,role:user.role,team:user.team||null}, JWT_SECRET, {expiresIn:'30d'});
}
function auth(req,res,next) {
  const h=req.headers.authorization||'';
  const token=h.startsWith('Bearer ')?h.slice(7):'';
  try { req.user=jwt.verify(token,JWT_SECRET); next(); }
  catch { return res.status(401).json({message:'Sesi tidak valid atau sudah habis'}); }
}
function canReadTeam(user,team){ return user.role==='Master One' || user.team===team; }

app.get('/api/health',async(req,res)=>{
  try { await q('SELECT 1'); res.json({ok:true,version:APP_VERSION,database:'postgres',time:now()}); }
  catch(e) { res.status(503).json({ok:false,message:'Database belum siap'}); }
});
app.get('/api/app-version',(req,res)=>res.json({version:APP_VERSION,app_url:APP_URL}));

app.post('/api/login',async(req,res)=>{
  try {
    const {role,team,name,password=''}=req.body||{};
    if (!role) return res.status(400).json({message:'Role wajib diisi'});
    if (role==='A1 Team') {
      if (!TEAMS.includes(team)) return res.status(400).json({message:'Tim tidak valid'});
      const result=await q('SELECT * FROM users WHERE role=$1 AND team=$2 LIMIT 1',['A1 Team',team]);
      const user=result.rows[0];
      if (!user || !bcrypt.compareSync(String(password),user.password_hash)) return res.status(401).json({message:'Kata sandi salah'});
      return res.json({token:tokenFor(user),user:{name:user.name,role:user.role,team:user.team}});
    }
    if (role==='Master One') {
      let result=await q("SELECT * FROM users WHERE role='Master One' LIMIT 1");
      let user=result.rows[0];
      if (!user) {
        const hash=bcrypt.hashSync('MASTER90',10);
        result=await q('INSERT INTO users(name,role,team,password_hash,created_at) VALUES($1,$2,$3,$4,$5) RETURNING *',
          ['Bpk. Feri Kusmanto','Master One',null,hash,now()]);
        user=result.rows[0];
      }
      if (!bcrypt.compareSync(String(password),user.password_hash)) return res.status(401).json({message:'Kata sandi salah'});
      return res.json({token:tokenFor(user),user:{name:user.name,role:user.role,team:null}});
    }
    if (role==='CoreBee Team') {
      const clean=String(name||'').trim();
      if (!clean || !TEAMS.includes(team)) return res.status(400).json({message:'Nama dan tim wajib diisi'});
      const sameName=await q('SELECT * FROM users WHERE lower(name)=lower($1) AND role=$2 LIMIT 1',[clean,'CoreBee Team']);
      if (sameName.rows[0] && sameName.rows[0].team!==team) return res.status(409).json({message:'Nama CoreBee sudah terdaftar di tim lain'});
      const existing=await q('SELECT * FROM users WHERE lower(name)=lower($1) AND role=$2 AND team=$3 LIMIT 1',[clean,'CoreBee Team',team]);
      let user=existing.rows[0];
      if (!user) {
        const created=await q('INSERT INTO users(name,role,team,created_at) VALUES($1,$2,$3,$4) RETURNING *',[clean,'CoreBee Team',team,now()]);
        user=created.rows[0];
      }
      return res.json({token:tokenFor(user),user:{name:user.name,role:user.role,team:user.team}});
    }
    return res.status(400).json({message:'Role tidak dikenal'});
  } catch(e) { console.error(e); return res.status(500).json({message:'Server/database error'}); }
});

app.get('/api/state/:team',auth,async(req,res)=>{
  try {
    const team=req.params.team;
    if (!TEAMS.includes(team)) return res.status(404).json({message:'Tim tidak ditemukan'});
    if (!canReadTeam(req.user,team)) return res.status(403).json({message:'Akses hanya untuk tim Anda'});
    const result=await q('SELECT state_json,updated_at FROM team_states WHERE team=$1',[team]);
    const row=result.rows[0];
    if (!row) return res.status(404).json({message:'Data tim belum tersedia'});
    res.json({team,state:JSON.parse(row.state_json),updated_at:row.updated_at});
  } catch(e) { console.error(e); res.status(500).json({message:'Gagal membaca database'}); }
});

app.put('/api/state/:team',auth,async(req,res)=>{
  try {
    const team=req.params.team;
    if (!TEAMS.includes(team)) return res.status(404).json({message:'Tim tidak ditemukan'});
    if (!canReadTeam(req.user,team)) return res.status(403).json({message:'Anda tidak boleh mengubah tim lain'});
    const state=req.body?.state;
    if (!state || typeof state!=='object') return res.status(400).json({message:'State tidak valid'});
    const stamp=now();
    await q('UPDATE team_states SET state_json=$1,updated_at=$2,updated_by=$3 WHERE team=$4',[JSON.stringify(state),stamp,req.user.name,team]);
    res.json({ok:true,team,updated_at:stamp});
  } catch(e) { console.error(e); res.status(500).json({message:'Gagal menyimpan database'}); }
});

app.put('/api/password',auth,async(req,res)=>{
  try {
    if (req.user.role!=='A1 Team' && req.user.role!=='Master One') return res.status(403).json({message:'Khusus A1/Master One'});
    const oldPw=String(req.body?.oldPassword||''); const newPw=String(req.body?.newPassword||'');
    if (!oldPw || !newPw) return res.status(400).json({message:'Sandi lama dan baru wajib diisi'});
    const result=await q('SELECT * FROM users WHERE id=$1 LIMIT 1',[req.user.id]);
    const user=result.rows[0];
    if (!user || !user.password_hash || !bcrypt.compareSync(oldPw,user.password_hash)) return res.status(401).json({message:'Kata sandi lama salah'});
    await q('UPDATE users SET password_hash=$1 WHERE id=$2',[bcrypt.hashSync(newPw,10),user.id]);
    res.json({ok:true});
  } catch(e) { console.error(e); res.status(500).json({message:'Gagal mengubah kata sandi'}); }
});

app.get('/api/master/state',auth,async(req,res)=>{
  try {
    if (req.user.role!=='Master One') return res.status(403).json({message:'Khusus Master One'});
    const result=await q('SELECT team,state_json,updated_at FROM team_states ORDER BY team');
    const teams={}; result.rows.forEach(r=>teams[r.team]=JSON.parse(r.state_json));
    res.json({teams,updated_at:now()});
  } catch(e) { console.error(e); res.status(500).json({message:'Gagal membaca data Master One'}); }
});

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

async function start(){
  await initDb();
  app.listen(PORT,()=>console.log(`MJA Berlian Free Online running on :${PORT}`));
}
start().catch(err=>{ console.error('Gagal memulai server:',err.message); process.exit(1); });
