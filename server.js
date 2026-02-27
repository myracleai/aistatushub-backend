/**
 * AIStatusHub.com — Backend Monitoring Server
 * 
 * Stack: Node.js + Express + SQLite (via better-sqlite3)
 * Pings every AI service endpoint every 60 seconds,
 * stores results, serves a JSON API for the frontend.
 * 
 * Deploy: Render.com (free), Railway.app, or VPS
 */

const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// DATABASE SETUP
// ─────────────────────────────────────────────
const db = new Database('./aistatushub.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    status TEXT NOT NULL,           -- 'operational' | 'degraded' | 'down'
    latency_ms INTEGER,             -- null if unreachable
    status_code INTEGER,            -- HTTP status code
    checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    severity TEXT NOT NULL,         -- 'degraded' | 'down'
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    is_resolved INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_checks_service ON checks(service_id);
  CREATE INDEX IF NOT EXISTS idx_checks_time ON checks(checked_at);
`);

// ─────────────────────────────────────────────
// AI SERVICES REGISTRY
// Add new services here — endpoint is what we ping.
// Some services don't have open ping endpoints, so
// we use their status page or main domain.
// ─────────────────────────────────────────────
const SERVICES = [
  // Language Models
  { id: 'chatgpt',       name: 'ChatGPT',          icon: '🤖', type: 'Language Model',    url: 'https://api.openai.com/v1/models',         authRequired: true,  statusPage: 'https://status.openai.com' },
  { id: 'claude',        name: 'Claude',            icon: '🧠', type: 'Language Model',    url: 'https://api.anthropic.com/v1/messages',    authRequired: true,  statusPage: 'https://status.anthropic.com' },
  { id: 'gemini',        name: 'Gemini',            icon: '✨', type: 'Language Model',    url: 'https://generativelanguage.googleapis.com', authRequired: true, statusPage: 'https://status.cloud.google.com' },
  { id: 'grok',          name: 'Grok (xAI)',        icon: '⚡', type: 'Language Model',    url: 'https://api.x.ai/v1/models',               authRequired: true,  statusPage: 'https://x.ai' },
  { id: 'perplexity',    name: 'Perplexity',        icon: '🔍', type: 'AI Search',         url: 'https://www.perplexity.ai',                authRequired: false, statusPage: 'https://www.perplexity.ai' },
  { id: 'mistral',       name: 'Mistral AI',        icon: '🌪️', type: 'Language Model',    url: 'https://api.mistral.ai/v1/models',         authRequired: true,  statusPage: 'https://mistral.ai' },
  { id: 'cohere',        name: 'Cohere',            icon: '🔷', type: 'Language Model',    url: 'https://api.cohere.ai/v1/check-api-key',   authRequired: true,  statusPage: 'https://status.cohere.com' },
  { id: 'llama',         name: 'Meta Llama (API)',  icon: '🦙', type: 'Language Model',    url: 'https://llama.developer.meta.com',          authRequired: false, statusPage: 'https://llama.developer.meta.com' },
  { id: 'groq',          name: 'Groq',              icon: '🚀', type: 'Language Model',    url: 'https://api.groq.com/openai/v1/models',    authRequired: true,  statusPage: 'https://groqstatus.com' },
  { id: 'together',      name: 'Together AI',       icon: '🤝', type: 'Language Model',    url: 'https://api.together.xyz/v1/models',        authRequired: true,  statusPage: 'https://status.together.ai' },
  // Image Generation
  { id: 'midjourney',    name: 'Midjourney',        icon: '🎨', type: 'Image Generation',  url: 'https://www.midjourney.com',               authRequired: false, statusPage: 'https://www.midjourney.com' },
  { id: 'dalle',         name: 'DALL·E 3',          icon: '🎭', type: 'Image Generation',  url: 'https://api.openai.com/v1/images/generations', authRequired: true, statusPage: 'https://status.openai.com' },
  { id: 'stability',     name: 'Stability AI',      icon: '🖼️', type: 'Image Generation',  url: 'https://api.stability.ai/v1/user/account',authRequired: true,  statusPage: 'https://stabilityai.instatus.com' },
  { id: 'ideogram',      name: 'Ideogram',          icon: '🎪', type: 'Image Generation',  url: 'https://ideogram.ai',                       authRequired: false, statusPage: 'https://ideogram.ai' },
  { id: 'flux',          name: 'Flux (BFL)',         icon: '⚡', type: 'Image Generation',  url: 'https://api.us1.bfl.ai/v1/get_result',     authRequired: true,  statusPage: 'https://bfl.ai' },
  // Video & Audio
  { id: 'runway',        name: 'Runway ML',         icon: '🎬', type: 'Video Generation',  url: 'https://api.runwayml.com/v1',              authRequired: true,  statusPage: 'https://status.runwayml.com' },
  { id: 'elevenlabs',    name: 'ElevenLabs',        icon: '🎙️', type: 'Voice AI',          url: 'https://api.elevenlabs.io/v1/user',        authRequired: true,  statusPage: 'https://status.elevenlabs.io' },
  { id: 'suno',          name: 'Suno',              icon: '🎵', type: 'Music AI',          url: 'https://suno.com',                         authRequired: false, statusPage: 'https://suno.com' },
  // Code Assistants
  { id: 'copilot',       name: 'GitHub Copilot',    icon: '💻', type: 'Code Assistant',    url: 'https://githubcopilot.com',                authRequired: false, statusPage: 'https://githubstatus.com' },
  { id: 'cursor',        name: 'Cursor',            icon: '⌨️', type: 'Code Assistant',    url: 'https://cursor.sh',                        authRequired: false, statusPage: 'https://cursor.sh' },
  // Search & Research
  { id: 'you',           name: 'You.com',           icon: '🌐', type: 'AI Search',         url: 'https://you.com',                          authRequired: false, statusPage: 'https://you.com' },
  { id: 'phind',         name: 'Phind',             icon: '💡', type: 'AI Search',         url: 'https://www.phind.com',                    authRequired: false, statusPage: 'https://www.phind.com' },
];

// ─────────────────────────────────────────────
// PING FUNCTION
// ─────────────────────────────────────────────
function pingService(service) {
  return new Promise((resolve) => {
    const start = Date.now();
    const urlObj = new URL(service.url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      timeout: 8000,
      headers: {
        'User-Agent': 'AIStatusHub-Monitor/1.0 (status checker; contact@aistatushub.com)',
        'Accept': 'application/json, text/html',
      }
    };

    const req = client.request(options, (res) => {
      const latency = Date.now() - start;
      // Consume body to avoid memory leaks
      res.on('data', () => {});
      res.on('end', () => {
        let status;
        if (res.statusCode >= 200 && res.statusCode < 400) {
          status = latency > 5000 ? 'degraded' : 'operational';
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          // Auth required but endpoint is alive — that's GOOD
          status = latency > 5000 ? 'degraded' : 'operational';
        } else if (res.statusCode === 429) {
          status = 'degraded'; // Rate limited
        } else if (res.statusCode >= 500) {
          status = 'down';
        } else {
          status = 'degraded';
        }
        resolve({ status, latency_ms: latency, status_code: res.statusCode });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 'down', latency_ms: null, status_code: null });
    });

    req.on('error', () => {
      resolve({ status: 'down', latency_ms: null, status_code: null });
    });

    req.end();
  });
}

// ─────────────────────────────────────────────
// MONITOR LOOP — runs every 60 seconds
// ─────────────────────────────────────────────
const insertCheck = db.prepare(`
  INSERT INTO checks (service_id, status, latency_ms, status_code) 
  VALUES (?, ?, ?, ?)
`);

const insertIncident = db.prepare(`
  INSERT INTO incidents (service_id, title, description, severity)
  VALUES (?, ?, ?, ?)
`);

const resolveIncident = db.prepare(`
  UPDATE incidents SET is_resolved = 1, resolved_at = CURRENT_TIMESTAMP
  WHERE service_id = ? AND is_resolved = 0
`);

const getLastStatus = db.prepare(`
  SELECT status FROM checks WHERE service_id = ? 
  ORDER BY checked_at DESC LIMIT 1
`);

async function runMonitorCycle() {
  console.log(`[${new Date().toISOString()}] Running monitor cycle for ${SERVICES.length} services...`);
  
  const results = await Promise.allSettled(
    SERVICES.map(s => pingService(s).then(r => ({ ...r, service: s })))
  );

  for (const result of results) {
    if (result.status === 'rejected') continue;
    const { service, status, latency_ms, status_code } = result.value;
    
    // Store check
    insertCheck.run(service.id, status, latency_ms, status_code);
    
    // Auto-create/resolve incidents
    const lastRow = getLastStatus.get(service.id);
    const prevStatus = lastRow?.status;
    
    if (prevStatus === 'operational' && (status === 'down' || status === 'degraded')) {
      insertIncident.run(
        service.id,
        `${service.name} - ${status === 'down' ? 'Outage Detected' : 'Performance Degradation'}`,
        `Automated detection: ${service.name} is ${status}. Last response: ${latency_ms ? latency_ms + 'ms' : 'timeout'}`,
        status
      );
      console.log(`⚠️  INCIDENT: ${service.name} → ${status}`);
    } else if (prevStatus !== 'operational' && status === 'operational') {
      resolveIncident.run(service.id);
      console.log(`✅ RESOLVED: ${service.name} → operational`);
    }

    console.log(`  ${status === 'operational' ? '✓' : status === 'degraded' ? '⚠' : '✗'} ${service.name}: ${status} ${latency_ms ? '(' + latency_ms + 'ms)' : '(timeout)'}`);
  }
}

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

// GET /api/status — all services latest status
app.get('/api/status', (req, res) => {
  const results = [];
  
  for (const service of SERVICES) {
    // Latest check
    const latest = db.prepare(`
      SELECT status, latency_ms, checked_at FROM checks 
      WHERE service_id = ? ORDER BY checked_at DESC LIMIT 1
    `).get(service.id);

    // 30-day uptime
    const uptimeRow = db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'operational' THEN 1 ELSE 0 END) as up
      FROM checks 
      WHERE service_id = ? AND checked_at > datetime('now', '-30 days')
    `).get(service.id);

    const uptime = uptimeRow.total > 0
      ? ((uptimeRow.up / uptimeRow.total) * 100).toFixed(2)
      : null;

    // 30-day incident count
    const incidents = db.prepare(`
      SELECT COUNT(*) as cnt FROM incidents 
      WHERE service_id = ? AND started_at > datetime('now', '-30 days')
    `).get(service.id);

    // Avg latency last 24h
    const avgLatency = db.prepare(`
      SELECT AVG(latency_ms) as avg FROM checks
      WHERE service_id = ? AND latency_ms IS NOT NULL 
        AND checked_at > datetime('now', '-24 hours')
    `).get(service.id);

    // 24h history for sparkline (hourly buckets)
    const history = db.prepare(`
      SELECT 
        strftime('%H', checked_at) as hour,
        AVG(latency_ms) as avg_latency,
        MIN(status) as worst_status
      FROM checks
      WHERE service_id = ? AND checked_at > datetime('now', '-24 hours')
      GROUP BY hour ORDER BY hour
    `).all(service.id);

    results.push({
      ...service,
      status: latest?.status || 'unknown',
      latency_ms: latest?.latency_ms || null,
      avg_latency_ms: avgLatency?.avg ? Math.round(avgLatency.avg) : null,
      uptime_30d: uptime,
      incidents_30d: incidents.cnt,
      checked_at: latest?.checked_at || null,
      history_24h: history,
    });
  }

  res.json({ 
    services: results,
    generated_at: new Date().toISOString(),
    total: results.length,
    operational: results.filter(s => s.status === 'operational').length,
    degraded: results.filter(s => s.status === 'degraded').length,
    down: results.filter(s => s.status === 'down').length,
  });
});

// GET /api/status/:id — single service detail
app.get('/api/status/:id', (req, res) => {
  const service = SERVICES.find(s => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });

  const checks = db.prepare(`
    SELECT status, latency_ms, status_code, checked_at 
    FROM checks WHERE service_id = ? 
    ORDER BY checked_at DESC LIMIT 100
  `).all(service.id);

  const incidents = db.prepare(`
    SELECT * FROM incidents WHERE service_id = ? 
    ORDER BY started_at DESC LIMIT 20
  `).all(service.id);

  // Daily uptime for last 30 days
  const dailyUptime = db.prepare(`
    SELECT 
      date(checked_at) as day,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'operational' THEN 1 ELSE 0 END) as up
    FROM checks
    WHERE service_id = ? AND checked_at > date('now', '-30 days')
    GROUP BY day ORDER BY day
  `).all(service.id);

  res.json({ service, checks, incidents, daily_uptime: dailyUptime });
});

// GET /api/incidents — recent incidents across all services
app.get('/api/incidents', (req, res) => {
  const incidents = db.prepare(`
    SELECT i.*, s.name as service_name
    FROM incidents i
    JOIN (SELECT id, name FROM (VALUES ${SERVICES.map(s => `('${s.id}','${s.name}')`).join(',')}) AS t(id,name)) s ON i.service_id = s.id
    ORDER BY started_at DESC LIMIT 50
  `).all();
  res.json({ incidents });
});

// GET /api/services — list of all monitored services
app.get('/api/services', (req, res) => {
  res.json({ services: SERVICES.map(s => ({ id: s.id, name: s.name, icon: s.icon, type: s.type, statusPage: s.statusPage })) });
});

// POST /api/report — user-submitted outage report
app.post('/api/report', (req, res) => {
  const { service_id, description } = req.body;
  const service = SERVICES.find(s => s.id === service_id);
  if (!service) return res.status(404).json({ error: 'Unknown service' });

  // In production: store to user_reports table, use for social proof
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id TEXT,
      description TEXT,
      reported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_hash TEXT
    )
  `).run();

  db.prepare(`INSERT INTO user_reports (service_id, description) VALUES (?, ?)`).run(service_id, description || '');
  res.json({ ok: true, message: 'Report received, thank you!' });
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🟢 AIStatusHub.com backend running on port ${PORT}`);
  console.log(`📡 Monitoring ${SERVICES.length} AI services`);
  
  // Run immediately on start, then every 60 seconds
  runMonitorCycle();
  setInterval(runMonitorCycle, 60 * 1000);
});

module.exports = app;
