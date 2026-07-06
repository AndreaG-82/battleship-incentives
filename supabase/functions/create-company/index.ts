import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

// Body: { name, primaryColor, secondaryColor, adminUsername, adminPassword }
// Public entry point (no caller auth yet — this *creates* the first
// account). Goes through the Auth Admin API so the account is created
// pre-confirmed, sidestepping the public signUp() endpoint's stricter
// anti-bot email validation/rate-limits, which don't make sense for
// these admin-provisioned synthetic accounts.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { name, primaryColor, secondaryColor, adminUsername, adminPassword } = await req.json();
    if (!name || !adminUsername || !adminPassword) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const slug = String(adminUsername).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    const email = `${slug}@admin.battleshipincentives.com`;

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password: adminPassword,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      const dup = String(createErr?.message || "").toLowerCase().includes("already");
      return new Response(JSON.stringify({ error: dup ? "username_taken" : createErr?.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: company, error: companyErr } = await adminClient
      .from("companies")
      .insert({ name, primary_color: primaryColor, secondary_color: secondaryColor })
      .select()
      .single();

    if (companyErr) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      throw companyErr;
    }

    const { error: profileErr } = await adminClient.from("profiles").insert({
      id: created.user.id,
      role: "manager",
      company_id: null,
      username: adminUsername,
      must_change_password: false,
    });

    if (profileErr) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      await adminClient.from("companies").delete().eq("id", company.id);
      throw profileErr;
    }

    const { error: linkErr } = await adminClient
      .from("manager_companies")
      .insert({ manager_id: created.user.id, company_id: company.id });

    if (linkErr) {
      await adminClient.auth.admin.deleteUser(created.user.id);
      await adminClient.from("companies").delete().eq("id", company.id);
      throw linkErr;
    }

    return new Response(JSON.stringify({ company }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
