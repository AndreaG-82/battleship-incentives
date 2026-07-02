import { createClient } from "npm:@supabase/supabase-js@2";

// Verifies the caller's JWT belongs to an admin profile for the given
// company, using the anon key + caller's Authorization header so normal
// RLS applies. Returns a service-role client for the privileged work
// only once that check has passed.
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
    .select("role, company_id")
    .eq("id", userData.user.id)
    .single();

  if (profileErr || !profile || profile.role !== "admin" || profile.company_id !== companyId) {
    throw new Response(JSON.stringify({ error: "not_authorized" }), { status: 403 });
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  return adminClient;
}
