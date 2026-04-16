# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Run locally (development):**
```bash
python app.py
```

**Run with gunicorn (production-style):**
```bash
gunicorn app:app
```

**Install dependencies:**
```bash
pip install -r requirements.txt
```

**Clear the data cache without restarting:**
```
GET /api/cache/clear
```

## Environment Setup

Copy `.env.template` to `.env` and fill in the values before running:

```
ODOO_URL=https://your-odoo-instance.odoo.com
ODOO_DB=your-db
ODOO_USERNAME=your@email.com
ODOO_API_KEY=your_api_key
CACHE_MINUTES=5   # optional, defaults to 5
```

The app uses `python-dotenv` to load `.env` automatically. In production (e.g., Render), set these as environment variables directly.

## Architecture

This is a single-file Flask app (`app.py`) that acts as a proxy/aggregator between an Odoo ERP instance and a browser dashboard.

**Data flow:**
1. `fetch_timesheets()` — authenticates with Odoo via XML-RPC (`/xmlrpc/2/common` + `/xmlrpc/2/object`) and pulls all `account.analytic.line` records (timesheets).
2. `get_cached_data()` — wraps the fetch with a simple in-memory cache (TTL controlled by `CACHE_MINUTES`). Cache is a module-level dict, so it resets on every process restart and is not shared across workers.
3. `filter_records()` — filters raw records by period (`ALL`, `3M`, `6M`, `MONTH`), employee name, project name, and billable status.
4. `process_timesheets()` — aggregates filtered records into KPI totals, per-employee stats, per-project stats, and a flat task list.

**API routes:**
- `GET /api/aggregates` — main endpoint; accepts query params `period`, `month`, `employee`, `project`, `billable`; returns aggregated dashboard data.
- `GET /api/employee?name=<name>` — per-employee breakdown with project hours.
- `GET /api/project?name=<name>` — per-project breakdown with employee hours.
- `GET /api/timesheets` — raw cached records (used by the legacy `static/script.js`).
- `GET /api/cache/clear` — invalidates the in-memory cache.
- `GET /public/<filename>` — serves files from the `public/` directory (e.g., PV logo).

**Frontend:**
- `templates/dashboard.html` — single-page dashboard rendered by Flask/Jinja2; contains all CSS (inline `<style>`) and JS (inline `<script>`). Uses Chart.js (CDN) for charts.
- `static/style.css` — supplemental styles.
- `static/script.js` — legacy table loader that hits `/api/timesheets`; largely superseded by inline JS in `dashboard.html`.
- `public/PV_Logo.png` — company logo served via `/public/` route.

**Billable detection:** Odoo instances vary in which field carries billability (`is_billable`, `to_invoice`, `invoice_status`). The code checks all three in both `process_timesheets()` and `filter_records()` for consistency.

**Deployment:** `Procfile` targets Render/Heroku via `gunicorn app:app`. The cache is per-process, so multi-worker deployments will have independent caches per worker.
