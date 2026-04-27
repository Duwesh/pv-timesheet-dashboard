import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { odooAuth, odooSearchRead } from "../_shared/odoo.ts";

Deno.serve(async (_req) => {
  try {
    const ODOO_URL      = Deno.env.get("ODOO_URL")!;
    const ODOO_DB       = Deno.env.get("ODOO_DB")!;
    const ODOO_USERNAME = Deno.env.get("ODOO_USERNAME")!;
    const ODOO_API_KEY  = Deno.env.get("ODOO_API_KEY")!;

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    console.log("Authenticating with Odoo...");
    const uid = await odooAuth(ODOO_URL, ODOO_DB, ODOO_USERNAME, ODOO_API_KEY);
    console.log(`Authenticated as uid=${uid}`);

    console.log("Fetching timesheets from Odoo...");
    const raw = await odooSearchRead(ODOO_URL, ODOO_DB, uid, ODOO_API_KEY);
    console.log(`Fetched ${raw.length} records`);

    const rows = raw
      .filter((r) => r.id && r.employee_id)
      .map((r) => ({
        id:          r.id,
        employee:    Array.isArray(r.employee_id) ? r.employee_id[1] : r.employee_id,
        hours:       r.unit_amount ?? 0,
        description: r.name ?? null,
        date:        r.date ?? null,
        project:     Array.isArray(r.project_id) ? r.project_id[1] : (r.project_id || null),
        task:        Array.isArray(r.task_id)    ? r.task_id[1]    : (r.task_id    || null),
        synced_at:   new Date().toISOString(),
      }));

    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error } = await supabase
        .from("timesheets")
        .upsert(rows.slice(i, i + BATCH), { onConflict: "id" });
      if (error) throw error;
    }

    return new Response(
      JSON.stringify({ synced: rows.length, at: new Date().toISOString() }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
