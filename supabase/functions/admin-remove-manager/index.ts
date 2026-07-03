import { corsHeaders } from "../_shared/cors.ts";
import { authorizePlatformAdmin } from "../_shared/authorizePlatformAdmin.ts";

// Body: { profileId }
// Platform-admin-only: removes a manager's account. Their campaign
// (company row, ships, players) is left intact — still fully visible
// and manageable by any platform admin, who can delete it separately
// via admin-delete-company if desired.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { profileId } = await req.json();
    if (!profileId) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = await authorizePlatformAdmin(req);

    const { data: target, error: targetErr } = await adminClient
      .from("profiles")
      .select("id, role")
      .eq("id", profileId)
      .single();

    if (targetErr || !target || target.role !== "manager") {
      return new Response(JSON.stringify({ error: "manager_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: delErr } = await adminClient.auth.admin.deleteUser(profileId);
    if (delErr) throw delErr;

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
