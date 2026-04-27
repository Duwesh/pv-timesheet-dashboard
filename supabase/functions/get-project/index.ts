import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const name = new URL(req.url).searchParams.get("name");
  if (!name) {
    return new Response(JSON.stringify({ error: "name param required" }), {
      status: 400,
      headers: cors,
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: cfgRow } = await supabase
    .from("staff_config")
    .select("config")
    .eq("id", 1)
    .single();
  const cfg = cfgRow?.config ?? { non_billable_tasks: [] };

  const isNonBillable = (r: Record<string, any>) =>
    (cfg.non_billable_tasks as string[]).some((kw) =>
      [r.task, r.description, r.project]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(kw.toLowerCase())
    );

  const { data: rows, error } = await supabase
    .from("timesheets")
    .select("*")
    .eq("project", name);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: cors,
    });
  }

  const records = rows ?? [];
  const total   = records.reduce((s: number, r: Record<string, any>) => s + (r.hours ?? 0), 0);

  const empAgg: Record<string, number> = {};
  for (const r of records) {
    empAgg[r.employee] = (empAgg[r.employee] ?? 0) + (r.hours ?? 0);
  }

  return new Response(
    JSON.stringify({
      name,
      total: +total.toFixed(2),
      tasks: records.map((r: Record<string, any>) => ({
        proj:     r.project     ?? "",
        task:     r.task        ?? r.description ?? "",
        desc:     r.description ?? "",
        hrs:      +(r.hours ?? 0).toFixed(2),
        employee: r.employee,
        date:     r.date,
        billable: !isNonBillable(r),
      })),
      employees: Object.entries(empAgg)
        .sort(([, a], [, b]) => b - a)
        .map(([employee, hrs]) => ({ employee, hrs: +(hrs as number).toFixed(2) })),
    }),
    { headers: { ...cors, "Content-Type": "application/json" } }
  );
});
