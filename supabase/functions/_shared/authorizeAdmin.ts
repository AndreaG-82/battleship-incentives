import { createClient } from "npm:@supabase/supabase-js@2";

// Verifies the caller's JWT belongs either to a platform admin (full
// access, any company) or to the manager of the given company, using
// the anon key + caller's Authorization header so normal RLS applies.
// Returns a service-role client for the privileged work only once
// that check has passed.
export async function authorizeAdmin(req: Request, companyId: string) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    throw new Response(JSON.stringify({ error: "missing_authorization" }), { status: 401 });
  }

  const callerClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    throw new Response(JSON.stringify({ error: "invalid_session" }), { status: 401 });
  }

  const { data: profile, error: profileErr } = await callerClient
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .single();

  let authorized = !!profile && profile.role === "admin";
  if (!authorized && profile?.role === "manager") {
    const { data: link } = await callerClient
      .from("manager_companies")
      .select("company_id")
      .eq("company_id", companyId)
      .maybeSingle();
    authorized = !!link;
  }
  if (profileErr || !authorized) {
    throw new Response(JSON.stringify({ error: "not_authorized" }), { status: 403 });
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  return adminClient;
}
