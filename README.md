# Feed

Personal AI-curated feed. Like Medium, but just for you.

## Features

- **Channels** - Organize content by topic (Entertainment, Business, Politics, etc.)
- **Topics** - Search queries that feed each channel
- **Filters** - Block terms globally or per-channel
- **Reports** - AI-generated summaries, not just link dumps

## Setup

1. Set `DATABASE_URL` environment variable (PostgreSQL)
2. `npm install`
3. `npm start`

## API

### Channels
- `GET /api/channels` - List all channels
- `POST /api/channels` - Create channel `{name, slug, description, color}`
- `DELETE /api/channels/:id` - Delete channel

### Topics
- `GET /api/topics` - List all topics
- `POST /api/topics` - Create topic `{channel_id, query, frequency}`
- `DELETE /api/topics/:id` - Delete topic

### Filters
- `GET /api/filters` - List all filters
- `POST /api/filters` - Create filter `{channel_id, term, filter_type}`
- `DELETE /api/filters/:id` - Delete filter

### Reports
- `GET /api/feed` - Get feed (optional `?channel=slug`)
- `GET /api/reports/:id` - Get single report
- `POST /api/reports` - Create report `{channel_id, title, subtitle, content, image_url, sources, read_time_min}`
- `DELETE /api/reports/:id` - Delete report
