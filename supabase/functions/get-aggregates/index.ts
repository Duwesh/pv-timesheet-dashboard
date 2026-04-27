import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const url    = new URL(req.url);
  const period = url.searchParams.get("period")   ?? "ALL";
  const month  = url.searchParams.get("month")    ?? null;
  const emp    = url.searchParams.get("employee") ?? "ALL";
  const proj   = url.searchParams.get("project")  ?? "ALL";
  const bill   = url.searchParams.get("billable") ?? null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: cfgRow } = await supabase
    .from("staff_config")
    .select("config")
    .eq("id", 1)
    .single();
  const cfg = cfgRow?.config ?? {
    non_billable_tasks: [],
    leave_tasks: [],
    new_employees: [],
    resigned_employees: [],
  };

  let query = supabase.from("timesheets").select("*");

  const today = new Date();
  if (period === "3M") {
    const from = new Date(today);
    from.setDate(from.getDate() - 90);
    query = query.gte("date", from.toISOString().split("T")[0]);
  } else if (period === "6M") {
    const from = new Date(today);
    from.setDate(from.getDate() - 180);
    query = query.gte("date", from.toISOString().split("T")[0]);
  } else if (period === "MONTH" && month) {
    const [y, m] = month.split("-").map(Number);
    const start  = `${month}-01`;
    const end    = new Date(y, m, 1).toISOString().split("T")[0];
    query = query.gte("date", start).lt("date", end);
  }

  if (emp  !== "ALL") query = query.eq("employee", emp);
  if (proj !== "ALL") query = query.eq("project",  proj);

  const { data: records, error } = await query;
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: cors,
    });
  }

  const rows = records ?? [];

  const isNonBillable = (r: any) =>
    (cfg.non_billable_tasks as string[]).some((kw) =>
      [r.task, r.description, r.project]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(kw.toLowerCase())
    );

  const isLeave = (r: any) =>
    (cfg.leave_tasks as string[]).some((kw) =>
      [r.task, r.description, r.project]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(kw.toLowerCase())
    );

  const filtered =
    bill === "true"  ? rows.filter((r) => !isNonBillable(r)) :
    bill === "false" ? rows.filter((r) =>  isNonBillable(r)) :
    rows;

  const resigned   = new Set(cfg.resigned_employees ?? []);
  const empMap:  Record<string, any> = {};
  const projMap: Record<string, any> = {};
  let leaveHours = 0;

  for (const r of filtered) {
    const hrs      = r.hours ?? 0;
    const billable = !isNonBillable(r);
    const leave    = isLeave(r);
    if (leave) leaveHours += hrs;

    if (!empMap[r.employee])
      empMap[r.employee] = { total: 0, bill: 0, leave: 0, projects: new Set(), tasks: 0 };
    empMap[r.employee].total += hrs;
    if (billable)  empMap[r.employee].bill  += hrs;
    if (leave)     empMap[r.employee].leave += hrs;
    if (r.project) empMap[r.employee].projects.add(r.project);
    empMap[r.employee].tasks++;

    if (r.project) {
      if (!projMap[r.project])
        projMap[r.project] = { hrs: 0, bill: 0, tasks: 0, emps: new Set() };
      projMap[r.project].hrs   += hrs;
      projMap[r.project].tasks++;
      if (billable) projMap[r.project].bill += hrs;
      projMap[r.project].emps.add(r.employee);
    }
  }

  const totalHours      = filtered.reduce((s, r) => s + (r.hours ?? 0), 0);
  const activeEmployees = Object.keys(empMap).filter((n) => !resigned.has(n));

  const employees = Object.entries(empMap)
    .sort(([, a], [, b]) => b.total - a.total)
    .map(([name, d], i) => ({
      no:       i + 1,
      name,
      short:    name.split(" ").map((w: string, idx: number) => idx === 0 ? w : w[0] + ".").join(" "),
      total:    +d.total.toFixed(2),
      bill:     +d.bill.toFixed(2),
      leave:    +d.leave.toFixed(2),
      billPct:  d.total > 0 ? +(d.bill / d.total).toFixed(4) : 0,
      projects: d.projects.size,
      tasks:    d.tasks,
      teamPct:  totalHours > 0 ? +(d.total / totalHours).toFixed(4) : 0,
    }));

  const projects = Object.entries(projMap)
    .sort(([, a], [, b]) => b.hrs - a.hrs)
    .map(([name, d], i) => ({
      no:      i + 1,
      name,
      hrs:     +d.hrs.toFixed(2),
      tasks:   d.tasks,
      pct:     totalHours > 0 ? +(d.hrs / totalHours).toFixed(5) : 0,
      emps:    d.emps.size,
      avgHrs:  d.tasks > 0 ? +(d.hrs / d.tasks).toFixed(2) : 0,
      bill:    +d.bill.toFixed(2),
      billPct: d.hrs > 0 ? +(d.bill / d.hrs).toFixed(4) : 0,
    }));

  const tasks = filtered.map((r) => ({
    proj:     r.project ?? "",
    task:     r.task    ?? r.description ?? "",
    desc:     r.description ?? "",
    hrs:      +(r.hours ?? 0).toFixed(2),
    employee: r.employee,
    date:     r.date,
    billable: !isNonBillable(r),
  }));

  return new Response(
    JSON.stringify({
      kpi: {
        total_hours:     +totalHours.toFixed(2),
        employees_count: activeEmployees.length,
        tasks_count:     filtered.length,
        projects_count:  Object.keys(projMap).length,
        leave_hours:     +leaveHours.toFixed(2),
      },
      employees,
      projects,
      tasks,
      _filters: { period, month, employee: emp, project: proj, billable: bill },
    }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  );
});
