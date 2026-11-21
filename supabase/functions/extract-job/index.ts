// Supabase Edge Function: extract-job
// Reads a repair addendum + inspection report (PDFs, base64) with Claude and returns the combined checklist.
//
// Two ways it is called:
//  1. From the app ("Read PDFs"): signed-in user, body {addendum_pdf, report_pdf}. Returns the checklist; the app saves it.
//  2. From the email automation (n8n / Make): header "x-intake-secret: <INTAKE_SECRET>",
//     body {addendum_pdf, report_pdf, save: true}. Creates the job in the database (status "setup") and returns its id.
//
// Secrets to set (Supabase -> Edge Functions -> Secrets): ANTHROPIC_API_KEY, INTAKE_SECRET, optional ANTHROPIC_MODEL.
import { createClient } from "npm:@supabase/supabase-js@2";
import { extract } from "./core.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-intake-secret",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // Who is calling?
  const secret = Deno.env.get("INTAKE_SECRET");
  const fromIntake = !!secret && req.headers.get("x-intake-secret") === secret;
  if (!fromIntake) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data } = await admin.auth.getUser(token);
    if (!data?.user) return json({ error: "Not signed in" }, 401);
  }

  let body: { addendum_pdf?: string; report_pdf?: string; save?: boolean; source?: string };
  try { body = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
  if (!body.addendum_pdf || !body.report_pdf) return json({ error: "Send both addendum_pdf and report_pdf (base64)" }, 400);

  try {
    const out = await extract({
      addendumB64: body.addendum_pdf,
      reportB64: body.report_pdf,
      apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
      model: Deno.env.get("ANTHROPIC_MODEL") || undefined,
    });
    if (!(fromIntake && body.save)) return json(out);

    const notes = out.warnings.length ? "CHECK: " + out.warnings.join(" | ") : "";
    const { data: job, error } = await admin.from("jobs")
      .insert({ address: out.address, buyer: out.buyer, seller: out.seller, status: "setup", notes })
      .select().single();
    if (error) throw error;
    const { error: e2 } = await admin.from("items")
      .insert(out.items.map((it, i) => ({ ...it, job_id: job.id, position: i })));
    if (e2) throw e2;
    return json({ job_id: job.id, address: out.address, items: out.items.length, warnings: out.warnings });
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
