import { supabase, playerEmail, adminEmail } from './supabaseClient.js';

function toCompany(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    logo: row.logo_url,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    rows: row.rows,
    cols: row.cols,
    launched: row.launched,
    totalShips: row.total_ships,
    createdAt: row.created_at,
  };
}

function toShip(row) {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    prizeName: row.prize_name,
    prizeDesc: row.prize_desc,
    cells: row.cells,
    hits: row.hits,
    sunk: row.sunk,
    winner: row.sunk
      ? {
          username: row.winner_username,
          businessName: row.winner_business_name,
          invoice: row.winner_invoice,
          ts: row.winner_ts,
        }
      : null,
  };
}

function toPlay(row) {
  return {
    invoice: row.invoice,
    username: row.username,
    businessName: row.business_name,
    ts: new Date(row.ts).getTime(),
    cell: row.cell,
    result: row.result,
    prizeName: row.prize_name,
    profileId: row.profile_id,
  };
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/data:(.*);base64/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

async function invokeAdminFn(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

/* ---------------- auth ---------------- */

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onAuthStateChange(cb) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return data.subscription;
}

export async function getMyProfile() {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) return null;
  const row = unwrap(
    await supabase.from('profiles').select('*').eq('id', userData.user.id).single()
  );
  return {
    id: row.id,
    role: row.role,
    companyId: row.company_id,
    username: row.username,
    businessName: row.business_name,
    mustChange: row.must_change_password,
  };
}

export async function signUpAndCreateCompany({ name, primaryColor, secondaryColor, adminUsername, adminPassword }) {
  const data = await invokeAdminFn('create-company', {
    name, primaryColor, secondaryColor, adminUsername, adminPassword,
  });
  await signInAdmin(adminUsername, adminPassword);
  return toCompany(data.company);
}

export async function signInAdmin(username, password) {
  const { error } = await supabase.auth.signInWithPassword({ email: adminEmail(username), password });
  if (error) throw error;
}

export async function signInPlayer(companyId, username, password) {
  const { error } = await supabase.auth.signInWithPassword({
    email: playerEmail(companyId, username),
    password,
  });
  if (error) throw error;
}

export async function changeOwnPassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
  const { error: clearErr } = await supabase.rpc('clear_must_change_password');
  if (clearErr) throw clearErr;
}

export async function signOut() {
  await supabase.auth.signOut();
}

/* ---------------- companies ---------------- */

export async function getLaunchedCompanies() {
  const rows = unwrap(await supabase.from('companies').select('*').eq('launched', true));
  return rows.map(toCompany);
}

export async function getCompanyById(id) {
  const row = unwrap(await supabase.from('companies').select('*').eq('id', id).single());
  return toCompany(row);
}

export async function updateCompanyMeta(companyId, patch) {
  const dbPatch = {};
  if ('name' in patch) dbPatch.name = patch.name;
  if ('primaryColor' in patch) dbPatch.primary_color = patch.primaryColor;
  if ('secondaryColor' in patch) dbPatch.secondary_color = patch.secondaryColor;
  if ('logo' in patch) dbPatch.logo_url = patch.logo;
  if ('rows' in patch) dbPatch.rows = patch.rows;
  if ('cols' in patch) dbPatch.cols = patch.cols;
  if ('launched' in patch) dbPatch.launched = patch.launched;
  const row = unwrap(
    await supabase.from('companies').update(dbPatch).eq('id', companyId).select().single()
  );
  return toCompany(row);
}

export async function uploadLogo(companyId, dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  const path = `${companyId}/logo.png`;
  const { error } = await supabase.storage.from('logos').upload(path, blob, {
    upsert: true,
    contentType: blob.type || 'image/png',
  });
  if (error) throw error;
  const { data } = supabase.storage.from('logos').getPublicUrl(path);
  return data.publicUrl;
}

/* ---------------- ships (admin only) ---------------- */

export async function getShips(companyId) {
  const rows = unwrap(
    await supabase.from('ships').select('*').eq('company_id', companyId).order('created_at')
  );
  return rows.map(toShip);
}

export async function addShip(companyId, ship) {
  await supabase
    .from('ships')
    .insert({
      company_id: companyId,
      name: ship.name,
      size: ship.size,
      prize_name: ship.prizeName,
      prize_desc: ship.prizeDesc,
      cells: ship.cells,
      hits: ship.cells.map(() => false),
    })
    .throwOnError();
}

export async function removeShip(shipId) {
  await supabase.from('ships').delete().eq('id', shipId).throwOnError();
}

export async function resetShips(companyId) {
  await supabase.from('ships').delete().eq('company_id', companyId).throwOnError();
}

/* ---------------- board state (players; sanitized) ---------------- */

export async function getBoardState(companyId) {
  const rows = unwrap(await supabase.rpc('board_state', { p_company_id: companyId }));
  const cellStates = {};
  for (const row of rows) {
    cellStates[`${row.r}-${row.c}`] = {
      state: row.state,
      prizeName: row.prize_name,
      shipName: row.ship_name,
    };
  }
  return cellStates;
}

export async function playMove(companyId, cell, invoice) {
  const rows = unwrap(
    await supabase.rpc('play_move', {
      p_company_id: companyId,
      p_r: cell.r,
      p_c: cell.c,
      p_invoice: invoice,
    })
  );
  const row = rows[0];
  return { result: row.result, prizeName: row.prize_name };
}

/* ---------------- plays ---------------- */

export async function getPlays(companyId) {
  const rows = unwrap(
    await supabase.from('plays').select('*').eq('company_id', companyId).order('ts', { ascending: false })
  );
  return rows.map(toPlay);
}

/* ---------------- players (admin only) ---------------- */

export async function getPlayers(companyId) {
  const rows = unwrap(
    await supabase.from('profiles').select('*').eq('company_id', companyId).eq('role', 'player')
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    businessName: r.business_name,
    mustChange: r.must_change_password,
  }));
}

export async function addPlayer(companyId, { username, password, businessName }) {
  const data = await invokeAdminFn('admin-create-player', {
    companyId,
    players: [{ username, password, businessName }],
  });
  const result = data.results[0];
  if (result.status !== 'added') throw new Error(result.status === 'duplicate' ? 'duplicate_username' : result.error);
  return result;
}

export async function bulkImportPlayers(companyId, players) {
  const data = await invokeAdminFn('admin-create-player', { companyId, players });
  return data.results;
}

export async function resetPlayerPassword(companyId, profileId) {
  await invokeAdminFn('admin-reset-player-password', { companyId, profileId });
}

export async function removePlayer(companyId, profileId) {
  await invokeAdminFn('admin-remove-player', { companyId, profileId });
}

export async function deleteCompany(companyId) {
  await invokeAdminFn('admin-delete-company', { companyId });
  await signOut();
}

/* ---------------- platform admin ---------------- */

export async function getAllCompanies() {
  const rows = unwrap(await supabase.from('companies').select('*').order('created_at', { ascending: false }));
  return rows.map(toCompany);
}

export async function getAllManagers() {
  const rows = unwrap(await supabase.from('profiles').select('*').eq('role', 'manager'));
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    companyId: r.company_id,
    mustChange: r.must_change_password,
  }));
}

export async function createManagerCampaign({ companyName, primaryColor, secondaryColor, managerUsername, managerPassword }) {
  const data = await invokeAdminFn('admin-create-manager', {
    companyName, primaryColor, secondaryColor, managerUsername, managerPassword,
  });
  return toCompany(data.company);
}

export async function removeManager(profileId) {
  await invokeAdminFn('admin-remove-manager', { profileId });
}

// Unlike deleteCompany(), doesn't sign out — a platform admin deleting
// someone else's campaign shouldn't end their own session.
export async function platformDeleteCompany(companyId) {
  await invokeAdminFn('admin-delete-company', { companyId });
}
