// Supabase Edge Function: archive-to-dropbox
// Copies a finished job's photos, videos, inspection screenshots and a summary.txt into the company Dropbox:
//   <DROPBOX_ROOT>/<date> - <address>/<NN code area>/<files>
// Called (a) by the app right after "Finish estimate" (signed-in user, body {job_id}), and
//        (b) every 15 minutes by the database scheduler (header x-intake-secret) to retry anything missed.
// Secrets: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, optional DROPBOX_ROOT (default "/Estimate Jobs"),
//          optional DROPBOX_TEAM_ROOT (team space root namespace id, only for Dropbox Business team folders).
import { createClient } from "npm:@supabase/supabase-js@2";
import { dropboxToken, jobFolder, itemFolder, mediaName, summaryText, upload } from "./dropbox.js";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-intake-secret" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });
const env = (k: string) => Deno.env.get(k) || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const fromCron = !!env("INTAKE_SECRET") && req.headers.get("x-intake-secret") === env("INTAKE_SECRET");
  if (!fromCron) {
    const { data } = await db.auth.getUser((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
    if (!data?.user) return json({ error: "Not signed in" }, 401);
  }
  if (!env("DROPBOX_REFRESH_TOKEN")) return json({ skipped: "Dropbox not set up" });

  const body = await req.json().catch(() => ({}));
  // One job per call keeps each run well inside the time limit; the scheduler picks up the rest.
  let q = db.from("jobs").select("*").eq("status", "done").is("archived_at", null).order("completed_at").limit(1);
  if (body.job_id) q = db.from("jobs").select("*").eq("id", body.job_id).eq("status", "done").limit(1);
  const { data: jobs, error } = await q;
  if (error) return json({ error: error.message }, 500);
  if (!jobs.length) return json({ archived: 0 });
  const job = jobs[0];

  try {
    const token = await dropboxToken({ appKey: env("DROPBOX_APP_KEY"), appSecret: env("DROPBOX_APP_SECRET"), refreshToken: env("DROPBOX_REFRESH_TOKEN") });
    const pathRoot = env("DROPBOX_TEAM_ROOT") || undefined;
    const { data: items, error: e1 } = await db.from("items").select("*, media(*)").eq("job_id", job.id).order("position");
    if (e1) throw e1;
    const base = jobFolder(env("DROPBOX_ROOT") || "/Estimate Jobs", job);
    let files = 0;
    for (const [i, it] of items.entries()) {
      for (const [k, m] of it.media.entries()) {
        const { data: blob, error: e2 } = await db.storage.from("media").download(m.path);
        if (e2) throw e2;
        await upload({ token, pathRoot, path: `${base}/${itemFolder(it, i)}/${mediaName(m, k)}`, bytes: new Uint8Array(await blob.arrayBuffer()) });
        files++;
      }
    }
    await upload({ token, pathRoot, path: `${base}/summary.txt`, bytes: new TextEncoder().encode(summaryText(job, items)) });
    await db.from("jobs").update({ archived_at: new Date().toISOString(), archive_error: null }).eq("id", job.id);
    return json({ archived: 1, job_id: job.id, folder: base, files });
  } catch (e) {
    const msg = (e as Error).message || String(e);
    await db.from("jobs").update({ archive_error: msg.slice(0, 500) }).eq("id", job.id);
    return json({ error: msg, job_id: job.id }, 500);
  }
});
