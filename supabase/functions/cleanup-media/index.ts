// Supabase Edge Function: cleanup-media
// Deletes photos/videos (and inspection screenshots) from jobs that were finished more than
// MEDIA_KEEP_DAYS days ago (default 90). Job details, costs, hours and notes are kept.
// Called once a day by the database scheduler (see README), with header "x-intake-secret".
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const secret = Deno.env.get("INTAKE_SECRET");
  if (!secret || req.headers.get("x-intake-secret") !== secret) return new Response("Forbidden", { status: 403 });

  const days = Number(Deno.env.get("MEDIA_KEEP_DAYS") || 90);
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let q = db
    .from("media")
    .select("id, path, items!inner(job_id, jobs!inner(status, completed_at, archived_at))")
    .eq("items.jobs.status", "done")
    .lt("items.jobs.completed_at", cutoff);
  // With Dropbox set up, never delete anything that hasn't been copied to Dropbox yet.
  if (Deno.env.get("DROPBOX_REFRESH_TOKEN")) q = q.not("items.jobs.archived_at", "is", null);
  const { data: rows, error } = await q.limit(1000);
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  let removed = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error: e1 } = await db.storage.from("media").remove(batch.map(r => r.path));
    if (e1) return new Response(JSON.stringify({ error: e1.message, removed }), { status: 500 });
    const { error: e2 } = await db.from("media").delete().in("id", batch.map(r => r.id));
    if (e2) return new Response(JSON.stringify({ error: e2.message, removed }), { status: 500 });
    removed += batch.length;
  }
  return new Response(JSON.stringify({ removed, keep_days: days, more: rows.length === 1000 }), {
    headers: { "content-type": "application/json" },
  });
});
