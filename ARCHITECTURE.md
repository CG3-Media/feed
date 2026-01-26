# Feed Architecture

Personal AI-curated news feed. Built simple, runs fast.

## Stack

- **Runtime:** Node.js + Express
- **Database:** PlanetScale (Postgres)
- **AI:** Claude (Anthropic API)
- **Deploy:** Dokploy → Digital Ocean

## Database Schema

### `feed_channels`
Categories for organizing content.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| name | VARCHAR(100) | Display name ("Music") |
| slug | VARCHAR(100) | URL-safe key ("music") |
| description | TEXT | What this channel covers |
| color | VARCHAR(7) | Hex color for UI |

### `feed_topics`
Search queries to track. Used by Dexo to know what to look for.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| channel_id | INTEGER | FK to channels |
| query | VARCHAR(500) | Search terms ("Kendrick Lamar news") |
| frequency | VARCHAR(20) | hourly / daily / weekly |
| favorited | BOOLEAN | Hearted topics get weighted in recommendations |
| active | BOOLEAN | Whether to track this |

### `feed_reports`
The actual content. Written by Dexo after researching topics.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| channel_id | INTEGER | FK to channels |
| title | VARCHAR(500) | Headline |
| subtitle | TEXT | Optional subhead |
| content | TEXT | Markdown body |
| image_url | TEXT | External image URL |
| image_data | TEXT | Base64-encoded image (fallback) |
| sources | JSONB | `[{title, url}]` array |
| key_entities | JSONB | `["Kendrick Lamar", "Grammy"]` for dedup |
| favorited | BOOLEAN | Hearted reports influence recommendations |
| read_time_min | INTEGER | Estimated read time |

### `feed_briefing`
Cached dashboard state. Single row, DB-backed cache.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Always 1 (single row) |
| know_ids | JSONB | `[12, 45, 67]` report IDs for "Know" section |
| watch_ids | JSONB | Report IDs for "Watch" section |
| listen_ids | JSONB | Report IDs for "Listen" section |
| expires_at | TIMESTAMP | Cache expiry (1 hour from creation) |
| created_at | TIMESTAMP | When briefing was generated |

### `feed_filters`
Block terms from appearing in feed.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL | Primary key |
| channel_id | INTEGER | FK (null = global filter) |
| term | VARCHAR(200) | Term to block |
| filter_type | VARCHAR(20) | "block" |

---

## API Endpoints

### Content

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/channels` | List all channels |
| POST | `/api/channels` | Create channel |
| GET | `/api/topics` | List all topics (favorited first) |
| POST | `/api/topics` | Create topic |
| GET | `/api/feed?channel=music` | List reports (optional channel filter) |
| GET | `/api/reports/:id` | Single report with rendered HTML |
| POST | `/api/reports` | Create report |
| PATCH | `/api/reports/:id` | Update report |
| DELETE | `/api/reports/:id` | Delete report |

### Favorites

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/topics/:id/favorite` | Toggle topic heart |
| POST | `/api/reports/:id/favorite` | Toggle report heart |
| GET | `/api/favorites/topics` | List hearted topics |
| GET | `/api/favorites/reports` | List hearted reports |

### AI-Powered

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/dashboard` | Know/Watch/Listen briefing (cached 1hr) |
| GET | `/api/dashboard?refresh=true` | Force regenerate briefing |
| GET | `/api/recommendations?days=7&limit=10` | AI-curated top picks with reasoning |

### Editorial (for Dexo)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/editorial/coverage?entities=["X"]&days=7` | Check if entities were covered recently |
| GET | `/api/editorial/recent-entities?days=7` | All entities mentioned recently |
| GET | `/api/editorial/summary` | Coverage stats by channel |

---

## Dashboard Flow

```
User loads dashboard
        ↓
Check feed_briefing table
        ↓
   expires_at > NOW()?
      /         \
    YES          NO
     ↓            ↓
  Return      Fetch recent reports
  cached           ↓
                Send to Claude:
                "Categorize into Know/Watch/Listen"
                   ↓
                Save to feed_briefing
                (UPSERT, expires_at = now + 1hr)
                   ↓
                Return fresh data
```

### Category Definitions (sent to Claude)

- **KNOW**: News and information to be informed about. Business updates, tech news, announcements. Not primarily media to consume.
- **WATCH**: Content where the PRIMARY purpose is watching video. Trailers, video essays, visual content.
- **LISTEN**: New music to listen to. Album releases, singles, songs.

---

## Recommendations Flow

```
GET /api/recommendations
        ↓
Fetch recent reports (last N days)
        ↓
Fetch favorited topics + entities from favorited reports
        ↓
Send to Claude:
"Pick the most important/interesting items.
 Corey especially cares about: [favorited topics]
 Entities from hearted reports: [entities]"
        ↓
Return ranked list with reasoning for each pick
```

---

## Content Creation (Dexo's Job)

1. Check `/api/editorial/recent-entities` to avoid duplicates
2. Search web for topic updates (Brave Search)
3. Synthesize findings into digest-style report
4. POST to `/api/reports` with:
   - `key_entities` for dedup tracking
   - `sources` array
   - Embedded YouTube/Spotify links where relevant
5. Optionally notify Corey via Telegram

### Editorial Voice

- Casual, like a friend keeping you in the loop
- Each topic gets its own section — don't mush unrelated news
- Quick hits, scannable, not magazine articles
- Big news = multiple sources. Small news = one source, quick note.
- Skip if nothing new — no fluff

---

## Auth

Simple token-based auth for the web UI:

1. Visit `/auth?token=XXX`
2. Sets `feed_token` httpOnly cookie (1 year)
3. All frontend routes check cookie
4. API routes are unprotected (used by Dexo)

---

## URLs

The SPA uses history.pushState for clean URLs:

- `/` — Dashboard (Know/Watch/Listen)
- `/channel/music` — Channel feed
- `/reports/42` — Report detail
- `/settings` — Manage channels, topics, filters
