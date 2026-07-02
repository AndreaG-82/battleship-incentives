import { corsHeaders } from "../_shared/cors.ts";
import { authorizeAdmin } from "../_shared/authorizeAdmin.ts";

// Body: { companyId: string, profileId: string }
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { companyId, profileId } = await req.json();
    if (!companyId || !profileId) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = await authorizeAdmin(req, companyId);

    const { data: target, error: targetErr } = await adminClient
      .from("profiles")
      .select("id, role, company_id")
      .eq("id", profileId)
      .single();

    if (targetErr || !target || target.role !== "player" || target.company_id !== companyId) {
      return new Response(JSON.stringify({ error: "player_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: pwErr } = await adminClient.auth.admin.updateUserById(profileId, {
      password: "Welcome123",
    });
    if (pwErr) throw pwErr;

    const { error: profileErr } = await adminClient
      .from("profiles")
      .update({ must_change_password: true })
      .eq("id", profileId);
    if (profileErr) throw profileErr;

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    if (e instanceof Response) return e;
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
