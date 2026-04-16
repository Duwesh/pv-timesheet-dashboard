from flask import Flask, render_template, jsonify, request
from flask import send_from_directory
import xmlrpc.client
import json
import os
from datetime import datetime, timedelta

# load environment variables from .env (optional)
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    # dotenv is optional in environments where env vars are already set
    pass

app = Flask(__name__)

ODOO_URL = os.getenv("ODOO_URL")
ODOO_DB = os.getenv("ODOO_DB")
ODOO_USERNAME = os.getenv("ODOO_USERNAME")
ODOO_API_KEY = os.getenv("ODOO_API_KEY")

CACHE = {"data": None, "timestamp": None}
CACHE_MINUTES = int(os.getenv("CACHE_MINUTES", 5))


def load_staff_config():
    """Read staff_config.json. Returns safe defaults if the file is missing."""
    config_path = os.path.join(app.root_path, "staff_config.json")
    try:
        with open(config_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"new_employees": [], "resigned_employees": [], "non_billable_tasks": []}


def _record_text(r):
    """Return a single lowercased string of all searchable fields in a record."""
    parts = []
    task = r.get("task_id")
    if isinstance(task, (list, tuple)) and len(task) > 1:
        parts.append(str(task[1]))
    parts.append(str(r.get("name") or ""))
    proj = r.get("project_id")
    if isinstance(proj, (list, tuple)) and len(proj) > 1:
        parts.append(str(proj[1]))
    return " ".join(parts).lower()


def is_billable(r, non_billable_keywords):
    """Return True if the record should be counted as billable.

    Non-billable when task/description/project name contains any keyword
    from non_billable_keywords (case-insensitive substring).
    """
    if not non_billable_keywords:
        return True
    text = _record_text(r)
    return not any(kw.lower() in text for kw in non_billable_keywords)


def is_leave(r, leave_keywords):
    """Return True if the record is a leave/holiday absence entry."""
    if not leave_keywords:
        return False
    text = _record_text(r)
    return any(kw.lower() in text for kw in leave_keywords)

def fetch_timesheets():
    # basic validation of required env vars
    if not ODOO_URL or not ODOO_DB or not ODOO_USERNAME or not ODOO_API_KEY:
        raise RuntimeError("Missing Odoo configuration. Check ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY.")

    # Ensure URL has http/https scheme
    if not (ODOO_URL.startswith("http://") or ODOO_URL.startswith("https://")):
        raise RuntimeError(f"ODOO_URL must start with http:// or https:// — got: {ODOO_URL!r}")

    common = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/common")
    uid = common.authenticate(ODOO_DB, ODOO_USERNAME, ODOO_API_KEY, {})

    models = xmlrpc.client.ServerProxy(f"{ODOO_URL}/xmlrpc/2/object")

    # Request additional fields to allow better aggregation on server side.
    fields = [
        "employee_id",
        "unit_amount",
        "name",
        "date",
        "project_id",
        "task_id",
    ]

    records = models.execute_kw(
        ODOO_DB,
        uid,
        ODOO_API_KEY,
        "account.analytic.line",
        "search_read",
        [[]],
        {"fields": fields}
    )

    return records

def get_cached_data():
    if CACHE["data"] and CACHE["timestamp"]:
        if datetime.now() - CACHE["timestamp"] < timedelta(minutes=CACHE_MINUTES):
            return CACHE["data"]

    data = fetch_timesheets()
    CACHE["data"] = data
    CACHE["timestamp"] = datetime.now()
    return data


def process_timesheets(records, non_billable_keywords=None, leave_keywords=None, resigned_employees=None):
    """Aggregate raw timesheet records into structures useful for the dashboard.

    non_billable_keywords: tasks treated as non-billable (case-insensitive substring).
    leave_keywords: subset of non-billable that count as leave/holiday hours.
    resigned_employees: excluded from the active employees_count KPI.
    """
    if non_billable_keywords is None:
        non_billable_keywords = []
    if leave_keywords is None:
        leave_keywords = []
    resigned_set = {n.strip() for n in (resigned_employees or [])}

    total_hours = 0.0
    employee_map = {}
    project_map = {}
    task_list = []

    for r in records or []:
        hrs = 0.0
        try:
            hrs = float(r.get("unit_amount") or 0)
        except Exception:
            hrs = 0.0
        total_hours += hrs

        # employee
        emp = r.get("employee_id") or []
        emp_name = emp[1] if isinstance(emp, (list, tuple)) and len(emp) > 1 else (str(emp) if emp else "Unknown")
        if emp_name not in employee_map:
            employee_map[emp_name] = {"name": emp_name, "total": 0.0, "tasks": 0, "bill": 0.0, "leave": 0.0, "projects": set()}
        employee_map[emp_name]["total"] += hrs
        employee_map[emp_name]["tasks"] += 1

        # billable: keyword-based (non_billable_tasks config), default billable
        billable = is_billable(r, non_billable_keywords)
        if billable:
            employee_map[emp_name]["bill"] += hrs
        elif is_leave(r, leave_keywords):
            employee_map[emp_name]["leave"] += hrs

        # project (best-effort): try project_id then fallback to name text
        proj = r.get("project_id")
        if isinstance(proj, (list, tuple)) and len(proj) > 1:
            proj_name = proj[1]
        else:
            # fallback: attempt to derive from the task name (may be coarse)
            proj_name = (r.get("name") or "Misc").split("-")[0].strip()

        if proj_name:
            if proj_name not in project_map:
                project_map[proj_name] = {"name": proj_name, "hrs": 0.0, "tasks": 0, "emps": set(), "bill": 0.0}
            project_map[proj_name]["hrs"] += hrs
            project_map[proj_name]["tasks"] += 1
            if emp_name:
                project_map[proj_name]["emps"].add(emp_name)
                employee_map[emp_name]["projects"].add(proj_name)
            if billable:
                project_map[proj_name]["bill"] += hrs

        # tasks list (simple)
        task_list.append({
            "proj": proj_name,
            "task": r.get("name") or "",
            "desc": r.get("name") or "",
            "hrs": hrs,
            "employee": emp_name,
            "date": r.get("date"),
            "billable": billable,
        })

    # build results
    total_leave = 0.0
    employees = []
    for i, (name, v) in enumerate(sorted(employee_map.items(), key=lambda kv: kv[1]["total"], reverse=True), start=1):
        bill = round(v.get("bill", 0.0), 2)
        leave = round(v.get("leave", 0.0), 2)
        total = round(v["total"], 2)
        total_leave += leave
        employees.append({
            "no": i,
            "name": name,
            "short": name.split(" ")[0],
            "total": total,
            "bill": bill,
            "leave": leave,
            "billPct": round((bill / total) if total else 0, 4),
            "projects": len(v.get("projects", set())),
            "tasks": v["tasks"],
            "teamPct": round((v["total"] / total_hours) if total_hours else 0, 4),
        })

    projects = []
    for i, (name, v) in enumerate(sorted(project_map.items(), key=lambda kv: kv[1]["hrs"], reverse=True), start=1):
        bill = round(v.get("bill", 0.0), 2)
        hrs = round(v["hrs"], 2)
        projects.append({
            "no": i,
            "name": name,
            "hrs": hrs,
            "tasks": v["tasks"],
            "pct": round((v["hrs"] / total_hours) if total_hours else 0, 5),
            "emps": len(v["emps"]),
            "avgHrs": round((v["hrs"] / v["tasks"]) if v["tasks"] else 0, 2),
            "bill": bill,
            "billPct": round((bill / hrs) if hrs else 0, 4),
        })

    active_count = sum(1 for name in employee_map if name not in resigned_set)
    kpi = {
        "total_hours": round(total_hours, 2),
        "employees_count": active_count,
        "tasks_count": len(task_list),
        "projects_count": len(project_map),
        "leave_hours": round(total_leave, 2),
    }

    return {"kpi": kpi, "employees": employees, "projects": projects, "tasks": task_list}


def filter_records(records, period="ALL", month=None, employee="ALL", project="ALL", billable=None, non_billable_keywords=None):
    """Filter raw records according to query parameters.

    period: ALL, 3M, 6M, MONTH
    month: YYYY-MM (used when period=MONTH)
    employee: employee name or ALL
    project: project name or ALL
    billable: 'true'|'false' or None
    non_billable_keywords: list of strings from staff_config.json
    """
    if not records:
        return []
    if non_billable_keywords is None:
        non_billable_keywords = []

    def matches_employee(r):
        if not employee or employee == "ALL":
            return True
        emp = r.get("employee_id") or []
        name = emp[1] if isinstance(emp, (list, tuple)) and len(emp) > 1 else (str(emp) if emp else "")
        return name == employee

    def extract_project_name(r):
        proj = r.get("project_id")
        if isinstance(proj, (list, tuple)) and len(proj) > 1:
            return proj[1]
        return (r.get("name") or "").split("-")[0].strip()

    def matches_project(r):
        if not project or project == "ALL":
            return True
        return extract_project_name(r) == project

    def matches_billable(r):
        if billable is None:
            return True
        b = is_billable(r, non_billable_keywords)
        want = str(billable).lower() in ("true", "1")
        return b if want else not b

    # period filtering
    now = datetime.now().date()
    start_date = None
    if period == "3M":
        start = datetime.now() - timedelta(days=90)
        start_date = start.date()
    elif period == "6M":
        start = datetime.now() - timedelta(days=180)
        start_date = start.date()
    elif period == "MONTH" and month:
        try:
            y, m = month.split("-")
            start_date = datetime(int(y), int(m), 1).date()
            # compute next month start for end comparison
            if int(m) == 12:
                end_date = datetime(int(y) + 1, 1, 1).date()
            else:
                end_date = datetime(int(y), int(m) + 1, 1).date()
        except Exception:
            start_date = None
            end_date = None
    else:
        start_date = None
        end_date = None

    out = []
    for r in records:
        # date check
        rd = r.get("date")
        try:
            rd_date = datetime.strptime(rd, "%Y-%m-%d").date() if rd else None
        except Exception:
            rd_date = None
        if start_date and rd_date:
            if period == "MONTH" and 'end_date' in locals():
                if not (rd_date >= start_date and rd_date < end_date):
                    continue
            else:
                if rd_date < start_date:
                    continue

        if not matches_employee(r):
            continue
        if not matches_project(r):
            continue
        if billable is not None:
            bval = str(billable).lower() in ("true", "1")
            if not matches_billable(r) if bval else matches_billable(r):
                # matches_billable returns True when record is billable; we want to keep when bval True
                pass
        out.append(r)
    return out


@app.route("/api/aggregates")
def aggregates():
    try:
        period = request.args.get("period", "ALL")
        month = request.args.get("month")
        employee = request.args.get("employee", "ALL")
        project = request.args.get("project", "ALL")
        billable = request.args.get("billable")

        cfg = load_staff_config()
        nb_keywords = cfg.get("non_billable_tasks", [])
        leave_kw = cfg.get("leave_tasks", [])
        resigned = cfg.get("resigned_employees", [])
        records = get_cached_data()
        filtered = filter_records(records, period=period, month=month, employee=employee, project=project, billable=billable, non_billable_keywords=nb_keywords)
        data = process_timesheets(filtered, non_billable_keywords=nb_keywords, leave_keywords=leave_kw, resigned_employees=resigned)
        data["_filters"] = {"period": period, "month": month, "employee": employee, "project": project, "billable": billable}
        return jsonify(data)
    except Exception as e:
        app.logger.exception("Error computing aggregates")
        return jsonify({"error": str(e)}), 500


@app.route("/api/employee")
def employee_detail():
    try:
        name = request.args.get("name")
        if not name:
            return jsonify({"error": "missing name parameter"}), 400
        cfg = load_staff_config()
        nb_keywords = cfg.get("non_billable_tasks", [])
        leave_kw = cfg.get("leave_tasks", [])
        resigned = cfg.get("resigned_employees", [])
        records = get_cached_data()
        filtered = filter_records(records, period="ALL", employee=name, non_billable_keywords=nb_keywords)
        data = process_timesheets(filtered, non_billable_keywords=nb_keywords, leave_keywords=leave_kw, resigned_employees=resigned)
        total = sum([t.get("hrs", 0) for t in data.get("tasks", [])])
        bill = sum([t.get("hrs", 0) for t in data.get("tasks", []) if t.get("billable")])
        projects = {}
        for t in data.get("tasks", []):
            p = t.get("proj") or "Misc"
            projects.setdefault(p, {"name": p, "hrs": 0.0, "tasks": 0})
            projects[p]["hrs"] += t.get("hrs", 0)
            projects[p]["tasks"] += 1
        proj_list = [v for k, v in sorted(projects.items(), key=lambda kv: kv[1]["hrs"], reverse=True)]
        return jsonify({"name": name, "total": round(total, 2), "bill": round(bill, 2), "tasks": data.get("tasks", []), "projects": proj_list})
    except Exception as e:
        app.logger.exception("Error computing employee detail")
        return jsonify({"error": str(e)}), 500


@app.route("/api/project")
def project_detail():
    try:
        name = request.args.get("name")
        if not name:
            return jsonify({"error": "missing name parameter"}), 400
        cfg = load_staff_config()
        nb_keywords = cfg.get("non_billable_tasks", [])
        leave_kw = cfg.get("leave_tasks", [])
        resigned = cfg.get("resigned_employees", [])
        records = get_cached_data()
        filtered = filter_records(records, period="ALL", project=name, non_billable_keywords=nb_keywords)
        data = process_timesheets(filtered, non_billable_keywords=nb_keywords, leave_keywords=leave_kw, resigned_employees=resigned)
        total = sum([t.get("hrs", 0) for t in data.get("tasks", [])])
        emp_map = {}
        for t in data.get("tasks", []):
            e = t.get("employee") or "Unknown"
            emp_map.setdefault(e, 0.0)
            emp_map[e] += t.get("hrs", 0)
        emp_list = [{"employee": k, "hrs": round(v, 2)} for k, v in sorted(emp_map.items(), key=lambda kv: kv[1], reverse=True)]
        return jsonify({"name": name, "total": round(total, 2), "tasks": data.get("tasks", []), "employees": emp_list})
    except Exception as e:
        app.logger.exception("Error computing project detail")
        return jsonify({"error": str(e)}), 500

@app.route("/")
def index():
    return render_template("dashboard.html")

@app.route("/api/timesheets")
def timesheets():
    try:
        data = get_cached_data()
        return jsonify(data)
    except Exception as e:
        app.logger.exception("Error fetching timesheets")
        return jsonify({"error": str(e)}), 500

@app.route("/api/cache/clear")
def clear_cache():
    CACHE["data"] = None
    return {"status": "cache cleared"}

@app.route("/api/staff-config")
def staff_config():
    """Return the manually maintained staff_config.json (new/resigned employees)."""
    config_path = os.path.join(app.root_path, "staff_config.json")
    try:
        with open(config_path, encoding="utf-8") as f:
            data = json.load(f)
        return jsonify(data)
    except FileNotFoundError:
        return jsonify({"new_employees": [], "resigned_employees": []})
    except Exception as e:
        app.logger.exception("Error reading staff_config.json")
        return jsonify({"error": str(e)}), 500


@app.route('/public/<path:filename>')
def public_static(filename):
    """Serve files from the 'public' directory (e.g. PV logo)."""
    public_dir = os.path.join(app.root_path, "public")
    return send_from_directory(public_dir, filename)


if __name__ == "__main__":
    app.run(debug=True)