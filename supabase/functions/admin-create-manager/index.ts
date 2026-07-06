import { corsHeaders } from "../_shared/cors.ts";
import { authorizePlatformAdmin } from "../_shared/authorizePlatformAdmin.ts";

// Body: { companyName, primaryColor, secondaryColor, managerUsername, managerPassword }
// Platform-admin-only: creates a company and a manager account for it
// in one step, mirroring create-company's self-signup flow but
// invoked by an existing admin on someone else's behalf.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { companyName, primaryColor, secondaryColor, managerUsername, managerPassword } = await req.json();
    if (!companyName || !managerUsername || !managerPassword) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = await authorizePlatformAdmin(req);

    const slug = String(managerUsername).trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    const email = `${slug}@admin.battleshipincentives.com`;

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password: managerPassword,
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
      .insert({ name: companyName, primary_color: primaryColor, secondary_color: secondaryColor })
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
      username: managerUsername,
      must_change_password: true,
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
    if (e instanceof Response) return e;
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
