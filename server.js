require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const { marked } = require('marked');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('pscale') ? { rejectUnauthorized: true } : false
});

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
      read_time_min INTEGER DEFAULT 5,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  console.log('Database initialized');
}

// API Routes

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
      ORDER BY t.created_at DESC
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
      SELECT r.*, c.name as channel_name, c.slug as channel_slug, c.color as channel_color
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
  const { channel_id, title, subtitle, content, image_url, sources, read_time_min } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO feed_reports (channel_id, title, subtitle, content, image_url, sources, read_time_min) 
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [channel_id, title, subtitle, content, image_url, JSON.stringify(sources || []), read_time_min || 5]
    );
    res.json(result.rows[0]);
  } catch (err) {
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

app.delete('/api/reports/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM feed_reports WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Feed running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
