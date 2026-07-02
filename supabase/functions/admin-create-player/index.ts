import { corsHeaders } from "../_shared/cors.ts";
import { authorizeAdmin } from "../_shared/authorizeAdmin.ts";

// Body: { companyId: string, players: { username: string, password: string, businessName?: string }[] }
// Used both for the single "Add a player" form (players.length === 1) and
// CSV bulk import (players.length > 1), so account creation always goes
// through one Auth-Admin-privileged code path.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { companyId, players } = await req.json();
    if (!companyId || !Array.isArray(players) || players.length === 0) {
      return new Response(JSON.stringify({ error: "bad_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = await authorizeAdmin(req, companyId);
    const results = [];

    for (const p of players) {
      const username = String(p.username || "").trim();
      const password = String(p.password || "").trim() || "Welcome123";
      const businessName = p.businessName ? String(p.businessName).trim() : null;

      if (!username) {
        results.push({ username, status: "error", error: "missing_username" });
        continue;
      }

      const emailSlug = username.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
      const email = `${emailSlug}@${companyId}.battleships.local`;

      const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (createErr || !created?.user) {
        const dup = String(createErr?.message || "").toLowerCase().includes("already");
        results.push({ username, status: dup ? "duplicate" : "error", error: createErr?.message });
        continue;
      }

      const { error: profileErr } = await adminClient.from("profiles").insert({
        id: created.user.id,
        role: "player",
        company_id: companyId,
        username,
        business_name: businessName,
        must_change_password: true,
      });

      if (profileErr) {
        // Roll back the orphaned auth user (e.g. username already taken in this company).
        await adminClient.auth.admin.deleteUser(created.user.id);
        const dup = profileErr.message?.toLowerCase().includes("duplicate");
        results.push({ username, status: dup ? "duplicate" : "error", error: profileErr.message });
        continue;
      }

      results.push({ username, status: "added" });
    }

    return new Response(JSON.stringify({ results }), {
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
