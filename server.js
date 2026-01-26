require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { marked } = require('marked');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Auth token from env (or generate one)
const FEED_TOKEN = process.env.FEED_TOKEN || '824c578a864bc97df5c1e8b61fb614f8b76c8ac725a32f5c';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('pscale') ? { rejectUnauthorized: true } : false
});

// Cookie parser middleware (simple implementation)
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      req.cookies[name] = value;
    });
  }
  next();
});

// Auth route - sets cookie and redirects
app.get('/auth', (req, res) => {
  const { token } = req.query;
  if (token === FEED_TOKEN) {
    // Set httpOnly cookie for 1 year
    res.setHeader('Set-Cookie', `feed_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    res.redirect('/');
  } else {
    res.status(401).send('Invalid token');
  }
});

// Logout route
app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'feed_token=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/auth-required');
});

// Auth check middleware for frontend
function requireAuth(req, res, next) {
  const token = req.cookies.feed_token;
  if (token === FEED_TOKEN) {
    next();
  } else {
    // Serve auth required page
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Feed - Access Required</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #fafafa; }
          .container { text-align: center; }
          h1 { font-size: 48px; margin-bottom: 16px; }
          p { color: #666; font-size: 18px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🔒</h1>
          <p>Access this feed via your personal link.</p>
        </div>
      </body>
      </html>
    `);
  }
}

// Serve static files (CSS, JS, etc) without auth
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));

// Initialize database tables
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_channels (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      slug VARCHAR(100) UNIQUE NOT NULL,
      description TEXT,
      color VARCHAR(7) DEFAULT '#6366f1',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_topics (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER REFERENCES feed_channels(id) ON DELETE CASCADE,
      query VARCHAR(500) NOT NULL,
      frequency VARCHAR(20) DEFAULT 'daily',
      active BOOLEAN DEFAULT true,
      last_run TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_filters (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER REFERENCES feed_channels(id) ON DELETE SET NULL,
      term VARCHAR(200) NOT NULL,
      filter_type VARCHAR(20) DEFAULT 'block',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_reports (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER REFERENCES feed_channels(id) ON DELETE CASCADE,
      title VARCHAR(500) NOT NULL,
      subtitle TEXT,
      content TEXT NOT NULL,
      image_url TEXT,
      sources JSONB DEFAULT '[]',
      key_entities JSONB DEFAULT '[]',
      read_time_min INTEGER DEFAULT 5,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  // Add key_entities column if it doesn't exist (migration)
  await pool.query(`
    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='feed_reports' AND column_name='key_entities') THEN
        ALTER TABLE feed_reports ADD COLUMN key_entities JSONB DEFAULT '[]';
      END IF;
    END $$;
  `);
  
  // Add image_data column for base64 storage
  await pool.query(`
    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='feed_reports' AND column_name='image_data') THEN
        ALTER TABLE feed_reports ADD COLUMN image_data TEXT;
      END IF;
    END $$;
  `);
  
  // Add favorited column to topics
  await pool.query(`
    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='feed_topics' AND column_name='favorited') THEN
        ALTER TABLE feed_topics ADD COLUMN favorited BOOLEAN DEFAULT false;
      END IF;
    END $$;
  `);
  
  // Add favorited column to reports
  await pool.query(`
    DO $$ 
    BEGIN 
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='feed_reports' AND column_name='favorited') THEN
        ALTER TABLE feed_reports ADD COLUMN favorited BOOLEAN DEFAULT false;
      END IF;
    END $$;
  `);
  
  // Briefing cache table (single row)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feed_briefing (
      id INTEGER PRIMARY KEY DEFAULT 1,
      know_ids JSONB DEFAULT '[]',
      watch_ids JSONB DEFAULT '[]',
      listen_ids JSONB DEFAULT '[]',
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  console.log('Database initialized');
}

// API Routes (no auth - used by Dexo)

// Get all channels
app.get('/api/channels', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM feed_channels ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create channel
app.post('/api/channels', async (req, res) => {
  const { name, slug, description, color } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO feed_channels (name, slug, description, color) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, slug, description, color || '#6366f1']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all topics
app.get('/api/topics', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, c.name as channel_name, c.slug as channel_slug 
      FROM feed_topics t 
      LEFT JOIN feed_channels c ON t.channel_id = c.id 
      ORDER BY t.favorited DESC NULLS LAST, t.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create topic
app.post('/api/topics', async (req, res) => {
  const { channel_id, query, frequency } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO feed_topics (channel_id, query, frequency) VALUES ($1, $2, $3) RETURNING *',
      [channel_id, query, frequency || 'daily']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all filters
app.get('/api/filters', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT f.*, c.name as channel_name 
      FROM feed_filters f 
      LEFT JOIN feed_channels c ON f.channel_id = c.id 
      ORDER BY f.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create filter
app.post('/api/filters', async (req, res) => {
  const { channel_id, term, filter_type } = req.body;
  try {
    const result = await pool.query(
      'INSERT INTO feed_filters (channel_id, term, filter_type) VALUES ($1, $2, $3) RETURNING *',
      [channel_id || null, term, filter_type || 'block']
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get feed (all reports or by channel)
app.get('/api/feed', async (req, res) => {
  const { channel, limit = 20, offset = 0 } = req.query;
  try {
    let query = `
      SELECT r.id, r.channel_id, r.title, r.subtitle, r.image_url, r.image_data, r.read_time_min, r.created_at, r.favorited,
             c.name as channel_name, c.slug as channel_slug, c.color as channel_color
      FROM feed_reports r
      LEFT JOIN feed_channels c ON r.channel_id = c.id
    `;
    const params = [];
    
    if (channel) {
      query += ' WHERE c.slug = $1';
      params.push(channel);
    }
    
    query += ' ORDER BY r.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get dashboard briefing - AI-categorized recent content (DB-cached)
app.get('/api/dashboard', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const forceRefresh = req.query.refresh === 'true';
  
  try {
    // Check for existing valid briefing
    if (!forceRefresh) {
      const cached = await pool.query(`
        SELECT * FROM feed_briefing WHERE id = 1 AND expires_at > NOW()
      `);
      
      if (cached.rows.length > 0) {
        const briefing = cached.rows[0];
        
        // Fetch full report data for each section
        const allIds = [...(briefing.know_ids || []), ...(briefing.watch_ids || []), ...(briefing.listen_ids || [])];
        
        if (allIds.length > 0) {
          const reports = await pool.query(`
            SELECT r.id, r.title, r.subtitle, r.image_url, r.image_data, r.read_time_min, r.created_at, r.favorited,
                   c.name as channel_name, c.slug as channel_slug, c.color as channel_color
            FROM feed_reports r
            LEFT JOIN feed_channels c ON r.channel_id = c.id
            WHERE r.id = ANY($1)
          `, [allIds]);
          
          const reportsById = Object.fromEntries(reports.rows.map(r => [r.id, r]));
          
          return res.json({
            know: (briefing.know_ids || []).map(id => reportsById[id]).filter(Boolean),
            watch: (briefing.watch_ids || []).map(id => reportsById[id]).filter(Boolean),
            listen: (briefing.listen_ids || []).map(id => reportsById[id]).filter(Boolean),
            generated_at: briefing.created_at,
            expires_at: briefing.expires_at,
            cached: true
          });
        }
      }
    }
    // Get recent reports from last 7 days
    const result = await pool.query(`
      SELECT r.id, r.channel_id, r.title, r.subtitle, r.content, r.image_url, r.image_data, r.read_time_min, r.created_at, r.favorited,
             c.name as channel_name, c.slug as channel_slug, c.color as channel_color
      FROM feed_reports r
      LEFT JOIN feed_channels c ON r.channel_id = c.id
      WHERE r.created_at > NOW() - INTERVAL '7 days'
      ORDER BY r.created_at DESC
      LIMIT 30
    `);
    
    const reports = result.rows;
    
    if (reports.length === 0 || !apiKey) {
      // Fallback if no reports or no API key
      return res.json({
        know: [],
        watch: [],
        listen: [],
        generated_at: new Date().toISOString()
      });
    }
    
    // Format reports for Claude
    const reportsForAnalysis = reports.map(r => ({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      channel: r.channel_name,
      content_preview: r.content?.substring(0, 300)
    }));
    
    // Ask Claude to categorize
    const anthropic = new Anthropic({ apiKey });
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Categorize these news items into three sections for a personal briefing dashboard.

**KNOW** - News and information. Business, tech, announcements, industry updates. Anything that's primarily informational goes here. This is the default category.

**WATCH** - Videos available to watch RIGHT NOW. Only include if the content contains or links to an actual video that exists today: a trailer that just dropped, a YouTube video, a music video. Do NOT include news about upcoming movies/shows that aren't released yet. Do NOT include announcements about future content.

**LISTEN** - Music available to stream RIGHT NOW. Only include if there's an actual song/album/single that is OUT and can be played today. Do NOT include news about upcoming albums, tour announcements, award nominations, or artist news. Those go in KNOW.

Key rules:
- "Artist announces album coming next month" → KNOW (not available yet)
- "New trailer drops for upcoming film" → WATCH (trailer is available now)
- "Artist wins Grammy" → KNOW (news, not media)
- "New single out now with Spotify link" → LISTEN (available to play)
- Tech/business news → KNOW (always)

Items:
${JSON.stringify(reportsForAnalysis, null, 2)}

Pick up to 5 items for each category. An item can only be in ONE category. If unsure, default to KNOW. It's fine if WATCH or LISTEN have fewer than 5 or even 0 items.

Respond with valid JSON only (no markdown):
{
  "know": [id1, id2, ...],
  "watch": [id1, id2, ...],
  "listen": [id1, id2, ...]
}`
      }]
    });
    
    // Parse response
    let categories;
    try {
      categories = JSON.parse(message.content[0].text);
    } catch (e) {
      // Fallback to empty if parse fails
      categories = { know: [], watch: [], listen: [] };
    }
    
    // Build response with full report data
    const getReportsById = (ids) => ids
      .map(id => reports.find(r => r.id === id))
      .filter(Boolean)
      .map(r => ({ ...r, content: undefined })); // Don't send full content
    
    // Save briefing to DB (1 hour expiry)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await pool.query(`
      INSERT INTO feed_briefing (id, know_ids, watch_ids, listen_ids, expires_at, created_at)
      VALUES (1, $1, $2, $3, $4, NOW())
      ON CONFLICT (id) DO UPDATE SET
        know_ids = $1,
        watch_ids = $2,
        listen_ids = $3,
        expires_at = $4,
        created_at = NOW()
    `, [
      JSON.stringify(categories.know || []),
      JSON.stringify(categories.watch || []),
      JSON.stringify(categories.listen || []),
      expiresAt
    ]);
    
    const dashboard = {
      know: getReportsById(categories.know || []),
      watch: getReportsById(categories.watch || []),
      listen: getReportsById(categories.listen || []),
      generated_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      cached: false
    };
    
    res.json(dashboard);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get single report
app.get('/api/reports/:id', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, c.name as channel_name, c.slug as channel_slug, c.color as channel_color
      FROM feed_reports r
      LEFT JOIN feed_channels c ON r.channel_id = c.id
      WHERE r.id = $1
    `, [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    
    const report = result.rows[0];
    report.content_html = marked(report.content);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create report (for Dexo to use)
app.post('/api/reports', async (req, res) => {
  const { channel_id, title, subtitle, content, image_url, image_data, sources, key_entities, read_time_min } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO feed_reports (channel_id, title, subtitle, content, image_url, image_data, sources, key_entities, read_time_min) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [channel_id, title, subtitle, content, image_url, image_data || null, JSON.stringify(sources || []), JSON.stringify(key_entities || []), read_time_min || 5]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper endpoint to fetch and convert image to base64
app.post('/api/image-to-base64', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  try {
    const https = require('https');
    const http = require('http');
    const protocol = url.startsWith('https') ? https : http;
    
    const fetchImage = (imageUrl) => new Promise((resolve, reject) => {
      protocol.get(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return fetchImage(response.headers.location).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const contentType = response.headers['content-type'] || 'image/jpeg';
          resolve({ buffer, contentType });
        });
        response.on('error', reject);
      }).on('error', reject);
    });
    
    const { buffer, contentType } = await fetchImage(url);
    const base64 = `data:${contentType};base64,${buffer.toString('base64')}`;
    res.json({ base64 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ EDITORIAL ENDPOINTS ============

// Check if entities have been covered recently
// GET /api/editorial/coverage?entities=["J. Cole","The Fall-Off"]&days=7
app.get('/api/editorial/coverage', async (req, res) => {
  const { entities, days = 7 } = req.query;
  try {
    const entityList = JSON.parse(entities || '[]');
    if (entityList.length === 0) {
      return res.json({ covered: [], uncovered: [] });
    }
    
    // Find reports from last N days that mention any of these entities
    const result = await pool.query(`
      SELECT id, title, key_entities, created_at
      FROM feed_reports
      WHERE created_at > NOW() - INTERVAL '${parseInt(days)} days'
      AND key_entities ?| $1
      ORDER BY created_at DESC
    `, [entityList]);
    
    // Figure out which entities were covered
    const coveredEntities = new Set();
    result.rows.forEach(report => {
      const reportEntities = report.key_entities || [];
      entityList.forEach(e => {
        if (reportEntities.some(re => re.toLowerCase() === e.toLowerCase())) {
          coveredEntities.add(e);
        }
      });
    });
    
    const covered = entityList.filter(e => coveredEntities.has(e));
    const uncovered = entityList.filter(e => !coveredEntities.has(e));
    
    res.json({
      covered,
      uncovered,
      recentReports: result.rows.map(r => ({ id: r.id, title: r.title, date: r.created_at }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all entities covered in recent reports
// GET /api/editorial/recent-entities?days=7&channel=music
app.get('/api/editorial/recent-entities', async (req, res) => {
  const { days = 7, channel } = req.query;
  try {
    let query = `
      SELECT r.key_entities, r.title, r.created_at, c.slug as channel_slug
      FROM feed_reports r
      LEFT JOIN feed_channels c ON r.channel_id = c.id
      WHERE r.created_at > NOW() - INTERVAL '${parseInt(days)} days'
    `;
    const params = [];
    
    if (channel) {
      query += ' AND c.slug = $1';
      params.push(channel);
    }
    
    query += ' ORDER BY r.created_at DESC';
    
    const result = await pool.query(query, params);
    
    // Aggregate all entities with their last coverage date
    const entityMap = {};
    result.rows.forEach(report => {
      const entities = report.key_entities || [];
      entities.forEach(entity => {
        const key = entity.toLowerCase();
        if (!entityMap[key] || new Date(report.created_at) > new Date(entityMap[key].lastCovered)) {
          entityMap[key] = {
            entity,
            lastCovered: report.created_at,
            reportTitle: report.title
          };
        }
      });
    });
    
    res.json({
      entities: Object.values(entityMap),
      reportCount: result.rows.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Editorial summary - what's been covered, what's stale
// GET /api/editorial/summary
app.get('/api/editorial/summary', async (req, res) => {
  try {
    // Get coverage stats by channel for last 7 days
    const channelStats = await pool.query(`
      SELECT c.name, c.slug, COUNT(r.id) as report_count, MAX(r.created_at) as last_report
      FROM feed_channels c
      LEFT JOIN feed_reports r ON c.id = r.channel_id AND r.created_at > NOW() - INTERVAL '7 days'
      GROUP BY c.id, c.name, c.slug
      ORDER BY c.name
    `);
    
    // Get most covered entities in last 7 days
    const recentReports = await pool.query(`
      SELECT key_entities FROM feed_reports WHERE created_at > NOW() - INTERVAL '7 days'
    `);
    
    const entityCounts = {};
    recentReports.rows.forEach(r => {
      (r.key_entities || []).forEach(e => {
        const key = e.toLowerCase();
        entityCounts[key] = (entityCounts[key] || 0) + 1;
      });
    });
    
    const topEntities = Object.entries(entityCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([entity, count]) => ({ entity, count }));
    
    res.json({
      channelStats: channelStats.rows,
      topEntities,
      totalReportsLast7Days: recentReports.rows.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ FAVORITES ============

// Toggle topic favorite
app.post('/api/topics/:id/favorite', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE feed_topics SET favorited = NOT COALESCE(favorited, false) WHERE id = $1 RETURNING id, query, favorited',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Topic not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle report favorite
app.post('/api/reports/:id/favorite', async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE feed_reports SET favorited = NOT COALESCE(favorited, false) WHERE id = $1 RETURNING id, title, favorited',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all favorited topics
app.get('/api/favorites/topics', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT t.*, c.name as channel_name FROM feed_topics t LEFT JOIN feed_channels c ON t.channel_id = c.id WHERE t.favorited = true ORDER BY t.query'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all favorited reports
app.get('/api/favorites/reports', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.id, r.title, r.subtitle, r.image_url, r.created_at, c.name as channel_name, c.slug as channel_slug
      FROM feed_reports r 
      LEFT JOIN feed_channels c ON r.channel_id = c.id 
      WHERE r.favorited = true 
      ORDER BY r.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ AI RECOMMENDATIONS ============

// Get AI-curated recommendations from recent reports
// GET /api/recommendations?days=7&limit=10
app.get('/api/recommendations', async (req, res) => {
  const { days = 7, limit = 10 } = req.query;
  
  // Check for API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }
  
  try {
    // 1. Pull recent reports
    const result = await pool.query(`
      SELECT r.id, r.title, r.subtitle, r.content, r.image_url, r.created_at, r.read_time_min,
             c.name as channel_name, c.slug as channel_slug, c.color as channel_color
      FROM feed_reports r
      LEFT JOIN feed_channels c ON r.channel_id = c.id
      WHERE r.created_at > NOW() - INTERVAL '${parseInt(days)} days'
      ORDER BY r.created_at DESC
      LIMIT 50
    `);
    
    if (result.rows.length === 0) {
      return res.json({ 
        recommendations: [], 
        reasoning: 'No reports found in the specified time range.',
        report_count: 0 
      });
    }
    
    // 2. Get favorited topics and reports for context
    const favTopics = await pool.query('SELECT query FROM feed_topics WHERE favorited = true');
    const favReports = await pool.query('SELECT title, key_entities FROM feed_reports WHERE favorited = true ORDER BY created_at DESC LIMIT 20');
    
    const favoritedTopics = favTopics.rows.map(t => t.query);
    const favoritedReportTitles = favReports.rows.map(r => r.title);
    const favoritedEntities = [...new Set(favReports.rows.flatMap(r => r.key_entities || []))];
    
    // 3. Format reports for Claude
    const reportsForAnalysis = result.rows.map(r => ({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle,
      channel: r.channel_name,
      content: r.content?.substring(0, 500) + (r.content?.length > 500 ? '...' : ''), // Truncate for token efficiency
      created_at: r.created_at,
      read_time_min: r.read_time_min
    }));
    
    // 4. Build context about preferences
    let preferencesContext = '';
    if (favoritedTopics.length > 0) {
      preferencesContext += `\nCorey's favorited topics (weight these higher): ${favoritedTopics.join(', ')}`;
    }
    if (favoritedEntities.length > 0) {
      preferencesContext += `\nEntities from reports Corey has hearted: ${favoritedEntities.slice(0, 15).join(', ')}`;
    }
    
    // 5. Send to Claude for analysis
    const anthropic = new Anthropic({ apiKey });
    
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are curating a personalized news feed for Corey. Analyze these recent reports and pick the ${parseInt(limit)} most important/interesting items.

Consider:
- Timeliness and relevance
- Impact and significance 
- Variety across channels (don't just pick from one category)
- Things Corey would actually want to know about
${preferencesContext}

Reports to analyze:
${JSON.stringify(reportsForAnalysis, null, 2)}

Respond with valid JSON only (no markdown, no code blocks):
{
  "recommendations": [
    {
      "id": <report_id>,
      "reason": "<brief explanation why this is important/interesting>"
    }
  ],
  "overall_summary": "<1-2 sentence summary of what's notable this week>"
}`
      }]
    });
    
    // 4. Parse Claude's response
    let parsed;
    try {
      const responseText = message.content[0].text;
      parsed = JSON.parse(responseText);
    } catch (parseErr) {
      return res.status(500).json({ 
        error: 'Failed to parse AI response', 
        raw: message.content[0].text 
      });
    }
    
    // 5. Enrich recommendations with full report data
    const recommendedIds = parsed.recommendations.map(r => r.id);
    const reasonMap = Object.fromEntries(parsed.recommendations.map(r => [r.id, r.reason]));
    
    const enriched = result.rows
      .filter(r => recommendedIds.includes(r.id))
      .map(r => ({
        ...r,
        content_preview: r.content?.substring(0, 200) + (r.content?.length > 200 ? '...' : ''),
        content: undefined, // Don't send full content in list
        ai_reason: reasonMap[r.id]
      }))
      .sort((a, b) => recommendedIds.indexOf(a.id) - recommendedIds.indexOf(b.id)); // Preserve Claude's ranking
    
    res.json({
      recommendations: enriched,
      overall_summary: parsed.overall_summary,
      report_count: result.rows.length,
      generated_at: new Date().toISOString()
    });
    
  } catch (err) {
    console.error('Recommendations error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete endpoints
app.delete('/api/channels/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM feed_channels WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/topics/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM feed_topics WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/filters/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM feed_filters WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a report (PATCH for partial updates)
app.patch('/api/reports/:id', async (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  
  // Build dynamic update query for provided fields only
  const allowedFields = ['title', 'subtitle', 'content', 'image_url', 'image_data', 'sources', 'key_entities', 'read_time_min'];
  const setClauses = [];
  const values = [];
  let paramIndex = 1;
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = $${paramIndex}`);
      values.push(field === 'sources' || field === 'key_entities' ? JSON.stringify(updates[field]) : updates[field]);
      paramIndex++;
    }
  }
  
  if (setClauses.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  
  values.push(id);
  
  try {
    const result = await pool.query(
      `UPDATE feed_reports SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/reports/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM feed_reports WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Protected frontend routes
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/settings', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/reports/*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Catch-all for SPA routes (with auth)
app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Feed running on port ${PORT}`);
    console.log(`Auth link: /auth?token=${FEED_TOKEN}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
