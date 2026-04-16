# PV Timesheet Dashboard

A real-time team timesheet analytics dashboard for **PV Advisory LLP**, built on top of Odoo ERP. It pulls timesheet data via the Odoo XML-RPC API, aggregates it server-side, and presents it as a clean interactive dashboard with filtering, drill-downs, and charts.

---

## Why This Exists

Odoo's built-in reporting is functional but not optimised for a quick team-wide view. This dashboard solves that by providing:

- A single page showing **total hours, billable hours, leave, and project distribution** across the whole team
- **Per-employee and per-project drill-downs** without navigating through Odoo menus
- **Manual configuration** for team changes (new joiners, resignations) and billability rules that Odoo doesn't track reliably
- A fast, cacheable read layer so the dashboard loads in seconds rather than waiting on Odoo

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Python 3, Flask |
| **Odoo integration** | XML-RPC (`xmlrpc.client`, stdlib) |
| **Production server** | Gunicorn |
| **Environment config** | python-dotenv |
| **Frontend** | Vanilla JS, Chart.js 4 (CDN) |
| **Icons** | Lucide (CDN) |
| **Fonts** | Inter, JetBrains Mono (Google Fonts) |
| **Deployment** | Render / Heroku (via `Procfile`) |

No database, no ORM, no frontend framework — the stack is intentionally minimal.

---

## Project Structure

```
├── app.py                  # Flask app — all backend logic
├── staff_config.json       # Manual team config (edit this regularly)
├── templates/
│   └── dashboard.html      # Single-page dashboard (HTML + CSS + JS)
├── static/
│   ├── style.css           # Supplemental styles
│   └── script.js           # Legacy table loader (superseded by inline JS)
├── public/
│   └── PV_Logo.png         # Company logo
├── .env.template           # Environment variable reference
├── Procfile                # Gunicorn entry point for deployment
└── requirements.txt        # Python dependencies
```

---

## Setup

### 1. Clone and install dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure environment variables

Copy `.env.template` to `.env` and fill in your Odoo credentials:

```env
ODOO_URL=https://your-instance.odoo.com
ODOO_DB=your-database-name
ODOO_USERNAME=your@email.com
ODOO_API_KEY=your_api_key
CACHE_MINUTES=5
```

To get your Odoo API key: **Odoo → Settings → My Profile → API Keys**.

### 3. Run locally

```bash
python app.py
```

Open `http://localhost:5000` in your browser.

### 4. Production

```bash
gunicorn app:app
```

On Render/Heroku, set the environment variables in the platform dashboard — no `.env` file needed.

---

## Configuration — `staff_config.json`

This file is the only thing you need to edit regularly. No code changes required.

```json
{
  "new_employees": ["Name of recently joined employee"],
  "resigned_employees": ["Name of resigned employee"],
  "non_billable_tasks": ["Leave", "Fun Friday", "Holiday", "Public Holiday", "Internal Meeting"],
  "leave_tasks": ["Leave", "Holiday", "Public Holiday"]
}
```

| Key | Purpose |
|---|---|
| `new_employees` | Shown with a green **NEW** badge in the employee table and a "New Joinings" card. |
| `resigned_employees` | Shown with a red **RESIGNED** badge, dimmed in the table, and excluded from the active employee headcount. |
| `non_billable_tasks` | Any timesheet entry whose task name, description, or project name contains one of these keywords (case-insensitive) is marked **non-billable**. Everything else is billable by default. |
| `leave_tasks` | Subset of `non_billable_tasks` that count specifically as **Leave + Holiday** hours in the KPI card. Other non-billable entries (e.g. Fun Friday) are excluded from this count. |

> Matching is a **case-insensitive substring check** — so `"Leave"` matches `"Annual Leave"`, `"Sick Leave"`, `"Leave - Others"`, etc.

Changes to `staff_config.json` take effect on the next API request — no server restart needed.

---

## How Data Flows

```
Odoo XML-RPC  →  fetch_timesheets()  →  in-memory cache (5 min TTL)
                                              ↓
                                      filter_records()   ← query params + staff_config
                                              ↓
                                      process_timesheets() ← billability + leave logic
                                              ↓
                                         JSON API  →  Dashboard (Charts + Tables)
```

1. **`fetch_timesheets()`** authenticates with Odoo and pulls all `account.analytic.line` records (the Odoo timesheet model).
2. **`get_cached_data()`** wraps the fetch with a module-level dict cache. TTL is set via `CACHE_MINUTES` (default 5). Cache resets on process restart and is not shared across Gunicorn workers.
3. **`filter_records()`** applies period, employee, project, and billable filters from query params.
4. **`process_timesheets()`** aggregates filtered records into KPIs, per-employee stats, per-project stats, and a flat task list.

### Billability logic

Odoo's billability fields (`is_billable`, `to_invoice`, `invoice_status`) are inconsistent across versions and configurations. This dashboard ignores them entirely and uses keyword matching against `non_billable_tasks` in `staff_config.json` instead. **Everything is billable by default** unless a keyword matches.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | Serves the dashboard HTML |
| `GET /api/aggregates` | Main data endpoint. Accepts `period`, `month`, `employee`, `project`, `billable` query params. |
| `GET /api/employee?name=` | Per-employee breakdown with project hours and task list. |
| `GET /api/project?name=` | Per-project breakdown with employee hours and task list. |
| `GET /api/staff-config` | Returns the parsed `staff_config.json`. |
| `GET /api/timesheets` | Raw cached Odoo records (legacy). |
| `GET /api/cache/clear` | Invalidates the in-memory cache immediately. |
| `GET /public/<filename>` | Serves files from the `public/` directory. |

---

## Dashboard Features

- **Overview tab** — team KPIs (total hours, billable hours, leave + holiday, active projects), charts for project distribution and employee billability
- **Projects tab** — ranked project table with hours, billability %, avg hrs/task, and drill-down panel
- **Employees tab** — ranked employee table with total, billable, leave hours, project count, and drill-down panel
- **Tasks tab** — full flat task list with project and employee filters
- **Global filters** — period (All time / Last 3M / Last 6M / Specific month), employee, project, billable-only toggle
- **Light / Dark theme** — single toggle button, defaults to system preference, persists in `localStorage`
- **Period banner** — shows the active date range with human-readable label and employee tags

---

## Deployment Notes

- The cache is **per-process**. With multiple Gunicorn workers, each worker maintains its own cache independently.
- To force a data refresh without restarting: `GET /api/cache/clear`
- `staff_config.json` is read fresh on every request — no restart needed for config changes.
