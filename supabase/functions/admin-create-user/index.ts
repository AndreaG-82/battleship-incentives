import { corsHeaders } from "../_shared/cors.ts";
import { authorizePlatformAdmin } from "../_shared/authorizePlatformAdmin.ts";

// Body: { role: 'admin' | 'manager', username, password, companyId? }
// Platform-admin-only. 'admin' creates another platform-wide admin
// account (no company). 'manager' attaches a manager to an EXISTING
// company (companyId required) - a company can have more than one
// manager, the profiles unique index only guards against duplicate
// usernames within the same company+role. For "new campaign + first
// manager" in one step, see admin-create-manager instead.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { role, username, password, companyId } = await req.json();
    if (!username || !password || (role !== "admin" && role !== "manager")) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (role === "manager" && !companyId) {
      return new Response(JSON.stringify({ error: "company_required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = await authorizePlatformAdmin(req);

    if (role === "manager") {
      const { data: company, error: companyErr } = await adminClient
        .from("companies")
        .select("id")
        .eq("id", companyId)
        .single();
      if (companyErr || !company) {
        return new Response(JSON.stringify({ error: "company_not_found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const slug = String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    const email = `${slug}@admin.battleshipincentives.com`;

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      const dup = String(createErr?.message || "").toLowerCase().includes("already");
      return new Response(JSON.stringify({ error: dup ? "username_taken" : createErr?.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: profileErr } = await adminClient.from("profiles").insert({
      id: created.user.id,
      role,
      company_id: role === "manager" ? companyId : null,
      username,
      must_change_password: true,
    });

    if (profileErr) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      const dup = profileErr.message?.toLowerCase().includes("duplicate");
      return new Response(JSON.stringify({ error: dup ? "username_taken" : profileErr.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
