import { corsHeaders } from "../_shared/cors.ts";
import { authorizeAdmin } from "../_shared/authorizeAdmin.ts";

// Body: { companyId: string }
// Deletes a campaign permanently: removes every player auth account
// tied to the company (the FK cascade on `companies` only reaches
// `profiles`/`ships`/`plays`/`manager_companies`, never `auth.users`),
// then deletes the company row itself, which cascades the rest.
// Managers keep their login even though this campaign is gone - they
// may own other campaigns, or none, and can create more later. Since
// managers no longer carry `company_id` (see manager_companies), the
// `company_id = companyId` lookup below only ever matches players.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { companyId } = await req.json();
    if (!companyId) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = await authorizeAdmin(req, companyId);

    const { data: profiles, error: profilesErr } = await adminClient
      .from("profiles")
      .select("id")
      .eq("company_id", companyId);
    if (profilesErr) throw profilesErr;

    const { error: companyErr } = await adminClient.from("companies").delete().eq("id", companyId);
    if (companyErr) throw companyErr;

    for (const p of profiles ?? []) {
      await adminClient.auth.admin.deleteUser(p.id);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
