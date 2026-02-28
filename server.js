/**
 * AIStatusHub.com — Backend Monitoring Server
 * Stack: Node.js + Express + sqlite3 (async, works on Render free tier)
 */

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const https = require('https');
const http = require('http');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

const db = new sqlite3.Database('./aistatushub.db', (err) => {
  if (err) console.error('DB error:', err);
  else console.log('Database connected');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, status TEXT NOT NULL, latency_ms INTEGER, status_code INTEGER, checked_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, severity TEXT NOT NULL, started_at DATETIME DEFAULT CURRENT_TIMESTAMP, resolved_at DATETIME, is_resolved INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS user_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, service_id TEXT, description TEXT, reported_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_checks_service ON checks(service_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_checks_time ON checks(checked_at)`);
});

const dbGet = (sql, p=[]) => new Promise((res,rej) => db.get(sql, p, (e,row) => e ? rej(e) : res(row)));
const dbAll = (sql, p=[]) => new Promise((res,rej) => db.all(sql, p, (e,rows) => e ? rej(e) : res(rows)));
const dbRun = (sql, p=[]) => new Promise((res,rej) => db.run(sql, p, function(e){ e ? rej(e) : res(this); }));

const SERVICES = [
  { id:'chatgpt',    name:'ChatGPT',        icon:'🤖', type:'Language Model',   url:'https://status.openai.com',         statusPage:'https://status.openai.com' },
  { id:'claude',     name:'Claude',          icon:'🧠', type:'Language Model',   url:'https://status.anthropic.com',      statusPage:'https://status.anthropic.com' },
  { id:'gemini',     name:'Gemini',          icon:'✨', type:'Language Model',   url:'https://www.google.com',            statusPage:'https://status.cloud.google.com' },
  { id:'grok',       name:'Grok (xAI)',      icon:'⚡', type:'Language Model',   url:'https://x.ai',                     statusPage:'https://x.ai' },
  { id:'perplexity', name:'Perplexity',      icon:'🔍', type:'AI Search',        url:'https://www.perplexity.ai',         statusPage:'https://www.perplexity.ai' },
  { id:'mistral',    name:'Mistral AI',      icon:'🌪', type:'Language Model',   url:'https://mistral.ai',                statusPage:'https://mistral.ai' },
  { id:'cohere',     name:'Cohere',          icon:'🔷', type:'Language Model',   url:'https://cohere.com',                statusPage:'https://status.cohere.com' },
  { id:'groq',       name:'Groq',            icon:'🚀', type:'Language Model',   url:'https://groq.com',                  statusPage:'https://groqstatus.com' },
  { id:'midjourney', name:'Midjourney',      icon:'🎨', type:'Image Generation', url:'https://www.midjourney.com',        statusPage:'https://www.midjourney.com' },
  { id:'dalle',      name:'DALL-E 3',        icon:'🎭', type:'Image Generation', url:'https://status.openai.com',         statusPage:'https://status.openai.com' },
  { id:'stability',  name:'Stability AI',    icon:'🖼', type:'Image Generation', url:'https://stabilityai.instatus.com',  statusPage:'https://stabilityai.instatus.com' },
  { id:'runway',     name:'Runway ML',       icon:'🎬', type:'Video Generation', url:'https://runwayml.com',              statusPage:'https://status.runwayml.com' },
  { id:'elevenlabs', name:'ElevenLabs',      icon:'🎙', type:'Voice AI',         url:'https://elevenlabs.io',             statusPage:'https://status.elevenlabs.io' },
  { id:'suno',       name:'Suno',            icon:'🎵', type:'Music AI',         url:'https://suno.com',                  statusPage:'https://suno.com' },
  { id:'copilot',    name:'GitHub Copilot',  icon:'💻', type:'Code Assistant',   url:'https://githubstatus.com',          statusPage:'https://githubstatus.com' },
  { id:'cursor',     name:'Cursor',          icon:'⌨', type:'Code Assistant',   url:'https://cursor.sh',                 statusPage:'https://cursor.sh' },
  { id:'groq',       name:'Groq',            icon:'🚀', type:'Language Model',   url:'https://groq.com',                  statusPage:'https://groqstatus.com' },
  { id:'you',        name:'You.com',         icon:'🌐', type:'AI Search',        url:'https://you.com',                   statusPage:'https://you.com' },
  { id:'phind',      name:'Phind',           icon:'💡', type:'AI Search',        url:'https://www.phind.com',             statusPage:'https://www.phind.com' },
];

function pingService(service) {
  return new Promise((resolve) => {
    const start = Date.now();
    const urlObj = new URL(service.url);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.request({ hostname: urlObj.hostname, path: urlObj.pathname || '/', method: 'GET', timeout: 8000, headers: { 'User-Agent': 'AIStatusHub-Monitor/1.0' } }, (res) => {
      const latency = Date.now() - start;
      res.on('data', () => {});
      res.on('end', () => {
        let status;
        if ([200,201,301,302,304,401,403].includes(res.statusCode)) status = latency > 5000 ? 'degraded' : 'operational';
        else if (res.statusCode === 429) status = 'degraded';
        else if (res.statusCode >= 500) status = 'down';
        else status = 'degraded';
        resolve({ status, latency_ms: latency, status_code: res.statusCode });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 'down', latency_ms: null, status_code: null }); });
    req.on('error', () => resolve({ status: 'down', latency_ms: null, status_code: null }));
    req.end();
  });
}

async function runMonitorCycle() {
  console.log(`[${new Date().toISOString()}] Running monitor cycle...`);
  const results = await Promise.allSettled(SERVICES.map(s => pingService(s).then(r => ({ ...r, service: s }))));
  for (const result of results) {
    if (result.status === 'rejected') continue;
    const { service, status, latency_ms, status_code } = result.value;
    const lastRow = await dbGet(`SELECT status FROM checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 1`, [service.id]).catch(() => null);
    const prevStatus = lastRow ? lastRow.status : null;
    await dbRun(`INSERT INTO checks (service_id, status, latency_ms, status_code) VALUES (?, ?, ?, ?)`, [service.id, status, latency_ms, status_code]).catch(() => {});
    if (prevStatus === 'operational' && (status === 'down' || status === 'degraded')) {
      await dbRun(`INSERT INTO incidents (service_id, title, description, severity) VALUES (?, ?, ?, ?)`, [service.id, `${service.name} - ${status === 'down' ? 'Outage' : 'Degraded'}`, `Automated: ${service.name} is ${status}`, status]).catch(() => {});
    } else if (prevStatus && prevStatus !== 'operational' && status === 'operational') {
      await dbRun(`UPDATE incidents SET is_resolved = 1, resolved_at = CURRENT_TIMESTAMP WHERE service_id = ? AND is_resolved = 0`, [service.id]).catch(() => {});
    }
    console.log(`  ${status === 'operational' ? 'OK' : 'ISSUE'} ${service.name}: ${status} ${latency_ms ? '('+latency_ms+'ms)' : '(timeout)'}`);
  }
}

app.get('/api/status', async (req, res) => {
  try {
    const results = await Promise.all(SERVICES.map(async (service) => {
      const latest = await dbGet(`SELECT status, latency_ms, checked_at FROM checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 1`, [service.id]).catch(() => null);
      const uptimeRow = await dbGet(`SELECT COUNT(*) as total, SUM(CASE WHEN status='operational' THEN 1 ELSE 0 END) as up FROM checks WHERE service_id = ? AND checked_at > datetime('now','-30 days')`, [service.id]).catch(() => ({ total:0, up:0 }));
      const incidents = await dbGet(`SELECT COUNT(*) as cnt FROM incidents WHERE service_id = ? AND started_at > datetime('now','-30 days')`, [service.id]).catch(() => ({ cnt:0 }));
      const avgLatency = await dbGet(`SELECT AVG(latency_ms) as avg FROM checks WHERE service_id = ? AND latency_ms IS NOT NULL AND checked_at > datetime('now','-24 hours')`, [service.id]).catch(() => ({ avg:null }));
      return { ...service, status: latest ? latest.status : 'unknown', latency_ms: latest ? latest.latency_ms : null, avg_latency_ms: avgLatency && avgLatency.avg ? Math.round(avgLatency.avg) : null, uptime_30d: uptimeRow.total > 0 ? ((uptimeRow.up / uptimeRow.total) * 100).toFixed(2) : null, incidents_30d: incidents.cnt, checked_at: latest ? latest.checked_at : null };
    }));
    res.json({ services: results, generated_at: new Date().toISOString(), total: results.length, operational: results.filter(s => s.status === 'operational').length, degraded: results.filter(s => s.status === 'degraded').length, down: results.filter(s => s.status === 'down').length });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Internal server error' }); }
});

app.get('/api/status/:id', async (req, res) => {
  const service = SERVICES.find(s => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  const checks = await dbAll(`SELECT status, latency_ms, status_code, checked_at FROM checks WHERE service_id = ? ORDER BY checked_at DESC LIMIT 100`, [service.id]).catch(() => []);
  const incidents = await dbAll(`SELECT * FROM incidents WHERE service_id = ? ORDER BY started_at DESC LIMIT 20`, [service.id]).catch(() => []);
  res.json({ service, checks, incidents });
});

app.get('/api/incidents', async (req, res) => {
  const incidents = await dbAll(`SELECT * FROM incidents ORDER BY started_at DESC LIMIT 50`).catch(() => []);
  const withNames = incidents.map(i => ({ ...i, service_name: (SERVICES.find(s => s.id === i.service_id) || {}).name || i.service_id }));
  res.json({ incidents: withNames });
});

app.get('/api/services', (req, res) => res.json({ services: SERVICES }));

app.post('/api/report', async (req, res) => {
  const { service_id, description } = req.body;
  if (!SERVICES.find(s => s.id === service_id)) return res.status(404).json({ error: 'Unknown service' });
  await dbRun(`INSERT INTO user_reports (service_id, description) VALUES (?, ?)`, [service_id, description || '']).catch(() => {});
  res.json({ ok: true, message: 'Report received!' });
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'AIStatusHub.com API running', services: SERVICES.length }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`AIStatusHub.com backend running on port ${PORT}`);
  console.log(`Monitoring ${SERVICES.length} AI services`);
  runMonitorCycle();
  setInterval(runMonitorCycle, 60 * 1000);
});
