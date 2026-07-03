import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// One-time bootstrap: creates the FIRST platform admin account. Only
// works when no admin exists yet — refuses once one does, so this
// can't be used to mint additional admins later (an existing admin
// uses admin-create-manager's pattern for onboarding people, or a
// future admin-promote-admin function if that's ever needed).
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { username, password } = await req.json();
    if (!username || !password) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { count, error: countErr } = await adminClient
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin");
    if (countErr) throw countErr;
    if (count && count > 0) {
      return new Response(JSON.stringify({ error: "admin_already_exists" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const slug = String(username).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    const email = `${slug}@admin.battleshipincentives.com`;

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      return new Response(JSON.stringify({ error: createErr?.message || "create_failed" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: profileErr } = await adminClient.from("profiles").insert({
      id: created.user.id,
      role: "admin",
      company_id: null,
      username,
      must_change_password: false,
    });
    if (profileErr) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      return new Response(JSON.stringify({ error: profileErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
