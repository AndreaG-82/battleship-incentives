import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy .env.example to .env.local and fill them in.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Supabase Auth rejects reserved/synthetic TLDs like .local, .test, .invalid
// as "invalid" emails, so these synthetic accounts use a .com-style domain
// even though it's never meant to receive real mail.
export const ADMIN_EMAIL_DOMAIN = 'admin.battleshipincentives.com';

export function playerEmail(companyId, username) {
  const slug = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return `${slug}@${companyId}.battleshipincentives.com`;
}

export function adminEmail(username) {
  const slug = username.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return `${slug}@${ADMIN_EMAIL_DOMAIN}`;
}
