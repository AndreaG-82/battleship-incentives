import { useState, useEffect } from 'react';
import {
  Ship, Trophy, Lock, Unlock, Upload, Plus, Trash2, LogOut, Anchor,
  Users, Building2, KeyRound, ChevronLeft, RefreshCw, Waves, Target
} from 'lucide-react';
import Papa from 'papaparse';
import * as api from './lib/api.js';

/* ---------------- helpers ---------------- */

function resizeImage(file, maxW = 280) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new window.Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png', 0.85));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function computeCellState(r, c, ships, invoices) {
  for (const s of ships) {
    const idx = s.cells.findIndex((cell) => cell.r === r && cell.c === c);
    if (idx > -1) {
      if (s.hits[idx]) return s.sunk ? { state: 'sunk', ship: s } : { state: 'hit' };
      return { state: 'hidden' };
    }
  }
  const missed = invoices.some((i) => i.cell.r === r && i.cell.c === c);
  return missed ? { state: 'miss' } : { state: 'hidden' };
}

function friendlyError(e, fallback) {
  const msg = String(e?.message || e || '');
  if (msg.includes('already registered') || msg.includes('already been registered') || msg.includes('username_taken')) return 'That admin username is taken, choose another.';
  if (msg.includes('Invalid login credentials')) return fallback;
  return msg || fallback;
}

const SHIP_TYPES = [
  { name: 'Aircraft Carrier', size: 8 },
  { name: 'Destroyer', size: 6 },
  { name: 'Cruiser', size: 4 },
  { name: 'Submarine', size: 3 },
  { name: 'Assault Boat', size: 2 },
  { name: 'Mine', size: 1 },
];

/* ---------------- ship silhouettes ---------------- */

// Every multi-cell type is drawn once in a shared 200x60 "horizontal"
// space (bow pointing right); Grid rotates the whole SVG 90deg for
// vertically-placed ships instead of drawing each orientation twice.
function shipTypeSvgBody(typeName) {
  const stroke = '#1e293b';
  switch (typeName) {
    case 'Aircraft Carrier':
      return (
        <>
          <polygon points="0,12 175,12 200,30 175,48 0,48" stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
          <rect x="105" y="1" width="26" height="13" rx="2" stroke={stroke} strokeWidth="2.5" />
          <line x1="20" y1="30" x2="170" y2="30" stroke={stroke} strokeWidth="2" strokeDasharray="6 6" opacity="0.6" />
        </>
      );
    case 'Destroyer':
      return (
        <>
          <polygon points="0,20 165,15 200,30 165,45 0,40" stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
          <rect x="55" y="8" width="26" height="14" rx="2" stroke={stroke} strokeWidth="2.5" />
          <rect x="115" y="10" width="22" height="12" rx="2" stroke={stroke} strokeWidth="2.5" />
          <line x1="68" y1="8" x2="68" y2="0" stroke={stroke} strokeWidth="2.5" />
        </>
      );
    case 'Cruiser':
      return (
        <>
          <polygon points="0,20 155,17 200,30 155,43 0,40" stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
          <rect x="65" y="7" width="32" height="15" rx="2" stroke={stroke} strokeWidth="2.5" />
          <line x1="81" y1="7" x2="81" y2="0" stroke={stroke} strokeWidth="2.5" />
        </>
      );
    case 'Submarine':
      return (
        <>
          <rect x="8" y="17" width="184" height="26" rx="13" stroke={stroke} strokeWidth="3" />
          <rect x="82" y="2" width="30" height="17" rx="4" stroke={stroke} strokeWidth="2.5" />
        </>
      );
    case 'Assault Boat':
      return (
        <polygon points="0,15 150,18 200,30 150,42 0,45" stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
      );
    default:
      // Unrecognised legacy ship name: generic tapered hull fallback.
      return (
        <polygon points="0,18 160,18 200,30 160,42 0,42" stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
      );
  }
}

function MineSvgBody() {
  const stroke = '#1e293b';
  const spikes = [0, 45, 90, 135, 180, 225, 270, 315];
  return (
    <>
      {spikes.map((deg) => (
        <line
          key={deg}
          x1="30" y1="30"
          x2={30 + 22 * Math.cos((deg * Math.PI) / 180)}
          y2={30 + 22 * Math.sin((deg * Math.PI) / 180)}
          stroke={stroke} strokeWidth="3"
        />
      ))}
      <circle cx="30" cy="30" r="16" stroke={stroke} strokeWidth="2.5" />
    </>
  );
}

function ShipShape({ typeName, cells, cellPx, gapPx = 4, color }) {
  const rows = cells.map((c) => c.r);
  const cols = cells.map((c) => c.c);
  const minR = Math.min(...rows);
  const minC = Math.min(...cols);
  const length = cells.length;
  const isMine = length === 1;
  const horizontal = isMine || rows.every((r) => r === rows[0]);

  const spanPx = length * cellPx + (length - 1) * gapPx;
  const boxW = horizontal ? spanPx : cellPx;
  const boxH = horizontal ? cellPx : spanPx;
  const svgW = isMine ? cellPx : spanPx;
  const svgH = isMine ? cellPx : cellPx;

  return (
    <div
      style={{ position: 'absolute', left: minC * (cellPx + gapPx), top: minR * (cellPx + gapPx), width: boxW, height: boxH, pointerEvents: 'none' }}
    >
      <svg
        width={svgW}
        height={svgH}
        viewBox={isMine ? '0 0 60 60' : '0 0 200 60'}
        fill={color || '#334155'}
        style={{ position: 'absolute', left: '50%', top: '50%', transform: `translate(-50%, -50%) ${horizontal ? '' : 'rotate(90deg)'}` }}
      >
        {isMine ? <MineSvgBody /> : shipTypeSvgBody(typeName)}
      </svg>
    </div>
  );
}

/* ---------------- board grid ---------------- */

function Grid({ rows, cols, ships, invoices, cellStates, onCellClick, selected, mode, primaryColor, adminView }) {
  const cellPx = Math.max(18, Math.min(44, Math.floor(480 / Math.max(cols, 1))));
  const GAP_PX = 4;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let state, prizeName;
      if (cellStates) {
        const cs = cellStates[`${r}-${c}`] || { state: 'hidden' };
        state = cs.state;
        prizeName = cs.prizeName;
      } else {
        const computed = computeCellState(r, c, ships, invoices);
        state = computed.state;
        prizeName = computed.ship?.prizeName;
      }
      const isSelected = selected && selected.r === r && selected.c === c;
      let cls = 'flex items-center justify-center rounded-md border text-xs transition select-none ';
      let style = { width: cellPx, height: cellPx };

      if (mode === 'place') {
        const occupied = ships.some((s) => s.cells.some((cell) => cell.r === r && cell.c === c));
        cls += occupied ? 'bg-slate-300 border-slate-400' : 'bg-sky-50 border-sky-100 hover:bg-sky-100 cursor-pointer';
      } else {
        const belongsToShip = ships && ships.some((s) => s.cells.some((cell) => cell.r === r && cell.c === c));
        if (state === 'hidden') {
          cls += onCellClick ? 'bg-sky-500/90 hover:bg-sky-400 cursor-pointer border-sky-600' : 'bg-sky-500/90 border-sky-600';
          if (adminView && belongsToShip) cls += ' ring-2 ring-amber-400 ring-inset';
        } else if (state === 'miss') {
          cls += 'bg-slate-100 border-slate-200';
        } else if (state === 'hit') {
          cls += 'bg-slate-700 border-slate-800';
        } else if (state === 'sunk') {
          cls += 'border-amber-500';
          style.background = primaryColor || '#f59e0b';
        }
      }
      if (isSelected) cls += ' ring-4 ring-offset-1 ring-emerald-400';

      cells.push(
        <div
          key={`${r}-${c}`}
          style={style}
          className={cls}
          onClick={() => onCellClick && onCellClick(r, c)}
          title={state === 'sunk' ? `Won: ${prizeName}` : ''}
        >
          {state === 'miss' && <Waves size={14} className="text-slate-400" />}
          {state === 'hit' && <Target size={14} className="text-white" />}
        </div>
      );
    }
  }

  // Ship silhouettes layered on top of the cells above: sunk ships
  // (grouped by ship_id, not name - two ships can share a type name)
  // when working off sanitized player board_state, or every placed
  // ship when the caller has raw ship data (admin placement preview
  // and the admin-only Live Monitor outline).
  let shapesToRender = [];
  if (cellStates) {
    const byShip = {};
    for (const key in cellStates) {
      const cs = cellStates[key];
      if (cs.state === 'sunk' && cs.shipId) {
        const [r, c] = key.split('-').map(Number);
        (byShip[cs.shipId] ||= { typeName: cs.shipName, cells: [] }).cells.push({ r, c });
      }
    }
    shapesToRender = Object.values(byShip);
  } else if (ships && (mode === 'place' || adminView)) {
    shapesToRender = ships.map((s) => ({ typeName: s.name, cells: s.cells }));
  }

  return (
    <div
      className="relative inline-grid gap-1 overflow-auto max-w-full p-2 bg-slate-100 rounded-lg"
      style={{ gridTemplateColumns: `repeat(${cols}, ${cellPx}px)` }}
    >
      {cells}
      {shapesToRender.map((s, i) => (
        <ShipShape key={i} typeName={s.typeName} cells={s.cells} cellPx={cellPx} gapPx={GAP_PX} color={primaryColor} />
      ))}
    </div>
  );
}

/* ---------------- landing / auth screens ---------------- */

function Landing({ onPlay, onAdmin }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-8 px-6 text-center bg-gradient-to-b from-slate-900 to-slate-700 text-white">
      <Anchor size={56} className="opacity-90" />
      <div>
        <h1 className="text-4xl font-bold tracking-tight mb-2">Battle for Prizes</h1>
        <p className="text-slate-300 max-w-md">
          A Battleship-style incentive game. Companies hide prizes on a board — staff play to sink ships and win.
        </p>
      </div>
      <div className="flex gap-4">
        <button onClick={onPlay} className="px-6 py-3 rounded-lg bg-white text-slate-900 font-semibold hover:bg-slate-100">
          Play a Campaign
        </button>
        <button onClick={onAdmin} className="px-6 py-3 rounded-lg border border-white/40 hover:bg-white/10 font-semibold">
          Company Admin
        </button>
      </div>
    </div>
  );
}

function CompanySelect({ companies, onPick, onBack }) {
  return (
    <div className="min-h-screen p-6 max-w-4xl mx-auto">
      <button onClick={onBack} className="flex items-center gap-1 text-slate-500 mb-6 hover:text-slate-800">
        <ChevronLeft size={18} />Back
      </button>
      <h2 className="text-2xl font-bold mb-6">Choose your campaign</h2>
      {companies.length === 0 && <p className="text-slate-500">No live campaigns yet. Check back soon.</p>}
      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
        {companies.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            className="border rounded-xl p-5 flex flex-col items-center gap-3 hover:shadow-md transition bg-white"
          >
            {c.logo ? <img src={c.logo} alt={c.name} className="h-16 object-contain" /> : <Building2 size={40} style={{ color: c.primaryColor }} />}
            <span className="font-semibold">{c.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PlayerLogin({ company, onLogin, onBack }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: `linear-gradient(180deg, ${company.secondaryColor}22, #fff)` }}>
      <div className="w-full max-w-sm bg-white border rounded-xl p-6 shadow-sm">
        <button onClick={onBack} className="flex items-center gap-1 text-slate-400 mb-4 text-sm hover:text-slate-700">
          <ChevronLeft size={16} />Back
        </button>
        <div className="flex flex-col items-center mb-6">
          {company.logo ? <img src={company.logo} className="h-14 object-contain mb-2" /> : <Building2 size={36} style={{ color: company.primaryColor }} />}
          <h2 className="font-bold text-lg">{company.name}</h2>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); onLogin(username, password); }} className="space-y-3">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username" className="w-full border rounded-lg px-3 py-2" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" className="w-full border rounded-lg px-3 py-2" />
          <button style={{ background: company.primaryColor }} className="w-full py-2 rounded-lg text-white font-semibold">Log in</button>
        </form>
      </div>
    </div>
  );
}

function ChangePasswordScreen({ onSubmit }) {
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4"><KeyRound size={20} /><h2 className="font-bold text-lg">Set a new password</h2></div>
        <p className="text-sm text-slate-500 mb-4">This is your first login — please choose a new password.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (pw1.length < 6) { setErr('Password must be at least 6 characters.'); return; }
            if (pw1 !== pw2) { setErr('Passwords do not match.'); return; }
            onSubmit(pw1);
          }}
          className="space-y-3"
        >
          <input type="password" value={pw1} onChange={(e) => setPw1(e.target.value)} placeholder="New password" className="w-full border rounded-lg px-3 py-2" />
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Confirm new password" className="w-full border rounded-lg px-3 py-2" />
          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button className="w-full py-2 rounded-lg bg-slate-900 text-white font-semibold">Save & Continue</button>
        </form>
      </div>
    </div>
  );
}

/* ---------------- player gameplay ---------------- */

function PlayerGame({ company, cellStates, plays, player, onLogout, onChangePassword, onPlay }) {
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [selected, setSelected] = useState(null);
  const [resultModal, setResultModal] = useState(null);
  const [busy, setBusy] = useState(false);

  const myPlays = plays.filter((p) => p.profileId === player.id);
  const recentWinners = plays.filter((p) => p.result === 'sunk').slice(0, 5);
  const totalShips = company.totalShips;
  const sunkShips = new Set(Object.values(cellStates).filter((c) => c.state === 'sunk').map((c) => c.shipName)).size;

  function handleCellClick(r, c) {
    const state = cellStates[`${r}-${c}`]?.state || 'hidden';
    if (state !== 'hidden') return;
    setSelected({ r, c });
  }

  async function confirmMove() {
    if (!selected) return;
    setBusy(true);
    const res = await onPlay(selected, invoiceNumber);
    setBusy(false);
    if (res) {
      setResultModal(res);
      setSelected(null);
      setInvoiceNumber('');
    }
  }

  return (
    <div className="min-h-screen pb-16">
      <header className="flex items-center justify-between px-6 py-4 border-b bg-white sticky top-0 z-10">
        <div className="flex items-center gap-3">
          {company.logo ? <img src={company.logo} className="h-9 object-contain" /> : <Building2 style={{ color: company.primaryColor }} />}
          <div>
            <div className="font-bold leading-tight">{company.name}</div>
            <div className="text-xs text-slate-400">{sunkShips}/{totalShips} prizes claimed</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500 hidden sm:inline">Hi, {player.businessName || player.username}</span>
          <button onClick={onChangePassword} className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1"><KeyRound size={14} />Password</button>
          <button onClick={onLogout} className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1"><LogOut size={14} />Log out</button>
        </div>
      </header>

      <div className="max-w-3xl mx-auto p-6">
        <div className="bg-white border rounded-xl p-4 mb-6">
          <p className="text-sm text-slate-600 mb-3">Enter your invoice / reference number, then tap a hidden block to play. Each number can only be used once.</p>
          <div className="flex gap-2 flex-wrap">
            <input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="Invoice / reference number"
              className="flex-1 min-w-[180px] border rounded-lg px-3 py-2"
            />
            <button
              disabled={!selected || busy}
              onClick={confirmMove}
              style={{ background: company.primaryColor }}
              className="px-4 py-2 rounded-lg text-white font-semibold disabled:opacity-40"
            >
              {busy ? 'Playing…' : selected ? `Play block ${selected.r + 1},${selected.c + 1}` : 'Select a block'}
            </button>
          </div>
        </div>

        <Grid rows={company.rows} cols={company.cols} cellStates={cellStates} onCellClick={handleCellClick} selected={selected} primaryColor={company.primaryColor} />

        {myPlays.length > 0 && (
          <div className="mt-8">
            <h3 className="font-semibold mb-2 text-sm text-slate-600">Your plays</h3>
            <div className="space-y-1">
              {myPlays.map((p, i) => (
                <div key={i} className="flex justify-between text-sm border-b py-1.5">
                  <span className="text-slate-500">Invoice {p.invoice}</span>
                  <span className={p.result === 'sunk' ? 'text-amber-600 font-semibold' : p.result === 'hit' ? 'text-slate-700' : 'text-slate-400'}>
                    {p.result === 'sunk' ? `🏆 Won: ${p.prizeName}` : p.result === 'hit' ? 'Hit — ship damaged' : 'Miss'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {recentWinners.length > 0 && (
          <div className="mt-8">
            <h3 className="font-semibold mb-2 text-sm text-slate-600">Recent winners</h3>
            <div className="space-y-1">
              {recentWinners.map((w, i) => (
                <div key={i} className="flex justify-between text-sm border-b py-1.5">
                  <span>{w.businessName || w.username}</span>
                  <span className="text-amber-600 font-medium">🏆 {w.prizeName}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {plays.length > 0 && (
          <div className="mt-8">
            <h3 className="font-semibold mb-2 text-sm text-slate-600">Activity log</h3>
            <div className="space-y-1 max-h-64 overflow-auto">
              {plays.slice(0, 20).map((p, i) => (
                <div key={i} className="flex justify-between text-sm border-b py-1.5">
                  <span className="text-slate-500">{p.businessName || p.username} played {p.cell.r + 1},{p.cell.c + 1}</span>
                  <span className={p.result === 'sunk' ? 'text-amber-600 font-semibold' : p.result === 'hit' ? 'text-slate-700' : 'text-slate-400'}>
                    {p.result === 'sunk' ? `🏆 Won: ${p.prizeName}` : p.result === 'hit' ? 'Hit' : 'Miss'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {resultModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-6 z-50" onClick={() => setResultModal(null)}>
          <div className="bg-white rounded-2xl p-8 max-w-sm w-full text-center" onClick={(e) => e.stopPropagation()}>
            {resultModal.result === 'sunk' && (
              <>
                <Trophy size={48} className="mx-auto text-amber-500 mb-3" />
                <h2 className="text-xl font-bold mb-1">You sunk it!</h2>
                <p className="text-slate-600 mb-4">You've won: <span className="font-semibold">{resultModal.prizeName}</span></p>
              </>
            )}
            {resultModal.result === 'hit' && (
              <>
                <Target size={48} className="mx-auto text-slate-700 mb-3" />
                <h2 className="text-xl font-bold mb-1">Direct hit!</h2>
                <p className="text-slate-600 mb-4">You've damaged a ship — keep an eye out, it's not sunk yet.</p>
              </>
            )}
            {resultModal.result === 'miss' && (
              <>
                <Waves size={48} className="mx-auto text-slate-400 mb-3" />
                <h2 className="text-xl font-bold mb-1">Miss!</h2>
                <p className="text-slate-600 mb-4">Nothing there. Try again with your next invoice number.</p>
              </>
            )}
            <button onClick={() => setResultModal(null)} style={{ background: company.primaryColor }} className="px-5 py-2 rounded-lg text-white font-semibold">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- admin: auth / create ---------------- */

function AdminAuth({ onLogin, onCreate, onBack }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white border rounded-xl p-6 shadow-sm">
        <button onClick={onBack} className="flex items-center gap-1 text-slate-400 mb-4 text-sm hover:text-slate-700">
          <ChevronLeft size={16} />Back
        </button>
        <h2 className="font-bold text-lg mb-4">Company Admin Login</h2>
        <form onSubmit={(e) => { e.preventDefault(); onLogin(username, password); }} className="space-y-3">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Admin username" className="w-full border rounded-lg px-3 py-2" />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin password" className="w-full border rounded-lg px-3 py-2" />
          <button className="w-full py-2 rounded-lg bg-slate-900 text-white font-semibold">Log in</button>
        </form>
        <div className="text-center mt-4 text-sm text-slate-500">
          New company? <button onClick={onCreate} className="text-slate-900 font-semibold underline">Create a campaign</button>
        </div>
      </div>
    </div>
  );
}

function AdminCreate({ onCreate, onBack }) {
  const [form, setForm] = useState({ name: '', primaryColor: '#0f172a', secondaryColor: '#0ea5e9', adminUsername: '', adminPassword: '', logo: null });
  const [busy, setBusy] = useState(false);

  async function handleLogo(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImage(file);
      setForm((f) => ({ ...f, logo: dataUrl }));
    } catch {}
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-md bg-white border rounded-xl p-6 shadow-sm">
        <button onClick={onBack} className="flex items-center gap-1 text-slate-400 mb-4 text-sm hover:text-slate-700">
          <ChevronLeft size={16} />Back
        </button>
        <h2 className="font-bold text-lg mb-4">Create a new campaign</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!form.name || !form.adminUsername || !form.adminPassword) return;
            setBusy(true);
            await onCreate(form);
            setBusy(false);
          }}
          className="space-y-3"
        >
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Company / campaign name" className="w-full border rounded-lg px-3 py-2" required />
          <div>
            <label className="text-sm text-slate-500 mb-1 block">Logo (optional)</label>
            <input type="file" accept="image/*" onChange={handleLogo} className="text-sm" />
            {form.logo && <img src={form.logo} className="h-12 mt-2 object-contain" />}
          </div>
          <div className="flex gap-3">
            <label className="flex-1 text-sm">Primary colour
              <input type="color" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })} className="w-full h-10 rounded-lg border mt-1" />
            </label>
            <label className="flex-1 text-sm">Secondary colour
              <input type="color" value={form.secondaryColor} onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })} className="w-full h-10 rounded-lg border mt-1" />
            </label>
          </div>
          <hr />
          <input value={form.adminUsername} onChange={(e) => setForm({ ...form, adminUsername: e.target.value })} placeholder="Choose an admin username" className="w-full border rounded-lg px-3 py-2" required />
          <input type="password" value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} placeholder="Choose an admin password" className="w-full border rounded-lg px-3 py-2" required />
          <button disabled={busy} className="w-full py-2 rounded-lg bg-slate-900 text-white font-semibold disabled:opacity-50">{busy ? 'Creating…' : 'Create campaign'}</button>
        </form>
      </div>
    </div>
  );
}

/* ---------------- admin: dashboard tabs ---------------- */

function BrandingTab({ company, onUpdateMeta, onDeleteCompany }) {
  const [name, setName] = useState(company.name);
  const [primaryColor, setPrimaryColor] = useState(company.primaryColor);
  const [secondaryColor, setSecondaryColor] = useState(company.secondaryColor);
  const [logo, setLogo] = useState(company.logo);

  async function handleLogo(e) {
    const file = e.target.files[0];
    if (!file) return;
    const dataUrl = await resizeImage(file);
    setLogo(dataUrl);
  }

  return (
    <div className="bg-white border rounded-xl p-6 max-w-md space-y-4">
      <h3 className="font-semibold">Branding</h3>
      <input value={name} onChange={(e) => setName(e.target.value)} className="w-full border rounded-lg px-3 py-2" />
      <div>
        <label className="text-sm text-slate-500 mb-1 block">Logo</label>
        <input type="file" accept="image/*" onChange={handleLogo} className="text-sm" />
        {logo && <img src={logo} className="h-12 mt-2 object-contain" />}
      </div>
      <div className="flex gap-3">
        <label className="flex-1 text-sm">Primary
          <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="w-full h-10 rounded-lg border mt-1" />
        </label>
        <label className="flex-1 text-sm">Secondary
          <input type="color" value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} className="w-full h-10 rounded-lg border mt-1" />
        </label>
      </div>
      <button onClick={() => onUpdateMeta({ name, primaryColor, secondaryColor, logo })} style={{ background: primaryColor }} className="px-4 py-2 rounded-lg text-white font-semibold">
        Save changes
      </button>

      <div className="border-t pt-4 mt-2">
        <h4 className="font-semibold text-sm text-red-600 mb-2">Danger zone</h4>
        <p className="text-xs text-slate-500 mb-3">Permanently deletes this campaign, its board, and every player account. This cannot be undone.</p>
        <button onClick={onDeleteCompany} className="px-4 py-2 rounded-lg border border-red-300 text-red-600 text-sm font-semibold hover:bg-red-50">
          Delete campaign permanently
        </button>
      </div>
    </div>
  );
}

function BoardTab({ company, ships, onUpdateMeta, onAddShip, onRemoveShip, onResetShips, notify }) {
  const [rows, setRows] = useState(company.rows || 8);
  const [cols, setCols] = useState(company.cols || 8);
  const [placing, setPlacing] = useState(null);
  const [newShip, setNewShip] = useState({ name: '', size: 0, prizeName: '', prizeDesc: '' });

  const boardReady = company.rows > 0 && company.cols > 0;

  async function createGrid() {
    if (rows < 4 || rows > 25 || cols < 4 || cols > 25) { notify('Grid size must be between 4 and 25 per side.', 'error'); return; }
    await onUpdateMeta({ rows, cols });
  }

  function startPlacing() {
    if (!newShip.name || !newShip.prizeName || newShip.size < 1 || newShip.size > Math.max(company.rows, company.cols)) {
      notify('Fill in ship name, size and prize name first.', 'error');
      return;
    }
    setPlacing({ ...newShip, cells: [] });
  }

  function cellOccupied(r, c) {
    return ships.some((s) => s.cells.some((cell) => cell.r === r && cell.c === c)) ||
      (placing && placing.cells.some((cell) => cell.r === r && cell.c === c));
  }

  function handlePlaceClick(r, c) {
    if (!placing) return;
    if (cellOccupied(r, c)) { notify('That block is already taken by another ship.', 'error'); return; }
    const cells = placing.cells;
    if (cells.length === 0) { setPlacing({ ...placing, cells: [{ r, c }] }); return; }
    if (cells.length >= placing.size) return;

    const first = cells[0];
    const sameRow = cells.every((cc) => cc.r === first.r);
    const sameCol = cells.every((cc) => cc.c === first.c);
    let ok = false;
    if (cells.length === 1) {
      ok = (r === first.r && Math.abs(c - first.c) === 1) || (c === first.c && Math.abs(r - first.r) === 1);
    } else if (sameRow && r === first.r) {
      const colsUsed = cells.map((cc) => cc.c);
      ok = c === Math.min(...colsUsed) - 1 || c === Math.max(...colsUsed) + 1;
    } else if (sameCol && c === first.c) {
      const rowsUsed = cells.map((cc) => cc.r);
      ok = r === Math.min(...rowsUsed) - 1 || r === Math.max(...rowsUsed) + 1;
    }
    if (!ok) { notify('Ships must be placed in a straight, unbroken line.', 'error'); return; }
    setPlacing({ ...placing, cells: [...cells, { r, c }] });
  }

  async function confirmPlacement() {
    await onAddShip({
      name: placing.name, size: placing.size, prizeName: placing.prizeName,
      prizeDesc: placing.prizeDesc, cells: placing.cells,
    });
    setPlacing(null);
    setNewShip({ name: '', size: 0, prizeName: '', prizeDesc: '' });
  }

  async function removeShip(id) {
    await onRemoveShip(id);
  }

  async function launch() {
    if (ships.length < 4) { notify('Add at least 4 different ships/prizes before launching.', 'error'); return; }
    await onUpdateMeta({ launched: true });
    notify('Campaign is live!', 'success');
  }

  async function resetCampaign() {
    if (!window.confirm('This clears the board, ships and all play history. Continue?')) return;
    await onResetShips();
    await onUpdateMeta({ launched: false, rows: 0, cols: 0 });
    notify('Campaign reset.', 'success');
  }

  if (!boardReady) {
    return (
      <div className="bg-white border rounded-xl p-6 max-w-sm space-y-3">
        <h3 className="font-semibold">Set up your board</h3>
        <p className="text-sm text-slate-500">Choose a grid size — as many blocks as you like.</p>
        <div className="flex gap-3">
          <label className="text-sm flex-1">Rows
            <input type="number" min={4} max={25} value={rows} onChange={(e) => setRows(+e.target.value)} className="w-full border rounded-lg px-3 py-2 mt-1" />
          </label>
          <label className="text-sm flex-1">Columns
            <input type="number" min={4} max={25} value={cols} onChange={(e) => setCols(+e.target.value)} className="w-full border rounded-lg px-3 py-2 mt-1" />
          </label>
        </div>
        <button onClick={createGrid} style={{ background: company.primaryColor }} className="px-4 py-2 rounded-lg text-white font-semibold">Create grid</button>
      </div>
    );
  }

  const previewShips = placing ? [...ships, { ...placing, hits: placing.cells.map(() => true) }] : ships;

  return (
    <div className="grid md:grid-cols-[1fr_320px] gap-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">Board ({company.rows}×{company.cols})</h3>
          {company.launched ? (
            <button onClick={resetCampaign} className="text-sm text-red-600 flex items-center gap-1"><RefreshCw size={14} />Reset campaign</button>
          ) : (
            <button onClick={launch} disabled={ships.length < 4} style={{ background: company.primaryColor }} className="px-4 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-40">
              Launch campaign
            </button>
          )}
        </div>
        <Grid rows={company.rows} cols={company.cols} ships={previewShips} invoices={[]} mode="place" onCellClick={company.launched ? undefined : handlePlaceClick} primaryColor={company.primaryColor} />
      </div>
      <div className="space-y-4">
        {!company.launched && (
          <div className="bg-white border rounded-xl p-4">
            <h4 className="font-semibold text-sm mb-3">Add a ship / prize</h4>
            {!placing ? (
              <div className="space-y-2">
                <select
                  value={newShip.name}
                  onChange={(e) => {
                    const type = SHIP_TYPES.find((t) => t.name === e.target.value);
                    setNewShip({ ...newShip, name: type?.name || '', size: type?.size || 0 });
                  }}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                >
                  <option value="" disabled>Select ship type…</option>
                  {SHIP_TYPES.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.size} blocks)</option>)}
                </select>
                <input value={newShip.prizeName} onChange={(e) => setNewShip({ ...newShip, prizeName: e.target.value })} placeholder="Prize name" className="w-full border rounded-lg px-3 py-2 text-sm" />
                <textarea value={newShip.prizeDesc} onChange={(e) => setNewShip({ ...newShip, prizeDesc: e.target.value })} placeholder="Prize description (optional)" className="w-full border rounded-lg px-3 py-2 text-sm" rows={2} />
                <button onClick={startPlacing} style={{ background: company.primaryColor }} className="w-full py-2 rounded-lg text-white text-sm font-semibold flex items-center justify-center gap-1">
                  <Plus size={14} />Place on board
                </button>
              </div>
            ) : (
              <div className="space-y-2 text-sm">
                <p className="text-slate-500">Click {placing.size} blocks in a straight line to place <strong>{placing.name}</strong>. ({placing.cells.length}/{placing.size})</p>
                <div className="flex gap-2">
                  <button onClick={() => setPlacing({ ...placing, cells: placing.cells.slice(0, -1) })} disabled={placing.cells.length === 0} className="flex-1 py-2 rounded-lg border text-sm disabled:opacity-40">Undo</button>
                  <button onClick={() => setPlacing(null)} className="flex-1 py-2 rounded-lg border text-sm text-red-600">Cancel</button>
                </div>
                <button onClick={confirmPlacement} disabled={placing.cells.length !== placing.size} style={{ background: company.primaryColor }} className="w-full py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-40">
                  Confirm placement
                </button>
              </div>
            )}
          </div>
        )}
        <div className="bg-white border rounded-xl p-4">
          <h4 className="font-semibold text-sm mb-3">Ships placed ({ships.length})</h4>
          <div className="space-y-2">
            {ships.map((s) => (
              <div key={s.id} className="flex items-center justify-between text-sm border-b pb-2">
                <div>
                  <div className="font-medium flex items-center gap-1"><Ship size={13} />{s.name} <span className="text-slate-400">({s.size})</span></div>
                  <div className="text-slate-500 text-xs">🏆 {s.prizeName}</div>
                </div>
                {!company.launched && <button onClick={() => removeShip(s.id)} className="text-slate-400 hover:text-red-600"><Trash2 size={15} /></button>}
              </div>
            ))}
            {ships.length === 0 && <p className="text-xs text-slate-400">No ships yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function PlayersTab({ users, onAddPlayer, onBulkImport, onResetPassword, onRemovePlayer, notify }) {
  const [form, setForm] = useState({ businessName: '', username: '', password: 'Welcome123' });
  const [csvBusy, setCsvBusy] = useState(false);

  async function addUser(e) {
    e.preventDefault();
    if (!form.username || !form.password) { notify('Username and password required.', 'error'); return; }
    await onAddPlayer(form);
    setForm({ businessName: '', username: '', password: 'Welcome123' });
  }

  function handleCSV(e) {
    const file = e.target.files[0];
    if (!file) return;
    setCsvBusy(true);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: async (res) => {
        const key = (row, names) => {
          const k = Object.keys(row).find((k) => names.includes(k.trim().toLowerCase()));
          return k ? String(row[k]).trim() : '';
        };
        const rows = [];
        for (const row of res.data) {
          const businessName = key(row, ['businessname', 'business', 'company']);
          const username = key(row, ['username', 'user']);
          const password = key(row, ['password', 'pass']) || 'Welcome123';
          if (!username) continue;
          rows.push({ businessName, username, password });
        }
        await onBulkImport(rows);
        setCsvBusy(false);
      },
      error: () => { notify('Could not read that CSV file.', 'error'); setCsvBusy(false); },
    });
  }

  return (
    <div className="grid md:grid-cols-[320px_1fr] gap-6">
      <div className="space-y-4">
        <div className="bg-white border rounded-xl p-4">
          <h4 className="font-semibold text-sm mb-3 flex items-center gap-1"><Upload size={14} />Bulk import (CSV)</h4>
          <p className="text-xs text-slate-500 mb-2">Columns: businessName, username, password</p>
          <input type="file" accept=".csv" onChange={handleCSV} disabled={csvBusy} className="text-sm" />
        </div>
        <div className="bg-white border rounded-xl p-4">
          <h4 className="font-semibold text-sm mb-3">Add a player</h4>
          <form onSubmit={addUser} className="space-y-2">
            <input value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} placeholder="Business name" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="Username" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Generic password" className="w-full border rounded-lg px-3 py-2 text-sm" />
            <button className="w-full py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold">Add player</button>
          </form>
        </div>
      </div>
      <div className="bg-white border rounded-xl p-4">
        <h4 className="font-semibold text-sm mb-3 flex items-center gap-1"><Users size={14} />Players ({users.length})</h4>
        <div className="overflow-auto max-h-[500px]">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-400 border-b"><th className="py-1">Business</th><th>Username</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b">
                  <td className="py-1.5">{u.businessName}</td>
                  <td>{u.username}</td>
                  <td>{u.mustChange ? <span className="text-amber-600 text-xs">Pending setup</span> : <span className="text-emerald-600 text-xs">Active</span>}</td>
                  <td className="text-right whitespace-nowrap">
                    <button onClick={() => onResetPassword(u.id)} className="text-slate-400 hover:text-slate-700 mr-2" title="Reset password"><RefreshCw size={14} /></button>
                    <button onClick={() => onRemovePlayer(u.id)} className="text-slate-400 hover:text-red-600" title="Remove"><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && <tr><td colSpan={4} className="text-slate-400 text-xs py-3">No players yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function MonitorTab({ company, ships, users, plays }) {
  const winners = ships.filter((s) => s.sunk);
  return (
    <div className="grid md:grid-cols-[1fr_320px] gap-6">
      <div>
        <h3 className="font-semibold mb-3">Live board</h3>
        <Grid rows={company.rows} cols={company.cols} ships={ships} invoices={plays} adminView primaryColor={company.primaryColor} />
        <p className="text-xs text-slate-400 mt-2">Amber outline = ship location (visible to admin only).</p>
      </div>
      <div className="space-y-4">
        <div className="bg-white border rounded-xl p-4 grid grid-cols-3 gap-2 text-center">
          <div><div className="text-xl font-bold">{users.length}</div><div className="text-xs text-slate-400">Players</div></div>
          <div><div className="text-xl font-bold">{plays.length}</div><div className="text-xs text-slate-400">Plays</div></div>
          <div><div className="text-xl font-bold">{winners.length}/{ships.length}</div><div className="text-xs text-slate-400">Won</div></div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <h4 className="font-semibold text-sm mb-3">Winners</h4>
          <div className="space-y-2">
            {winners.map((s) => (
              <div key={s.id} className="text-sm border-b pb-2">
                <div className="font-medium">🏆 {s.prizeName}</div>
                <div className="text-slate-500 text-xs">{s.winner.businessName || s.winner.username} · invoice {s.winner.invoice}</div>
              </div>
            ))}
            {winners.length === 0 && <p className="text-xs text-slate-400">No prizes won yet.</p>}
          </div>
        </div>
        <div className="bg-white border rounded-xl p-4">
          <h4 className="font-semibold text-sm mb-3">Recent activity</h4>
          <div className="space-y-1 max-h-64 overflow-auto">
            {plays.slice(0, 20).map((i, idx) => (
              <div key={idx} className="flex justify-between text-xs border-b py-1">
                <span>{i.businessName || i.username}</span>
                <span className={i.result === 'sunk' ? 'text-amber-600' : i.result === 'hit' ? 'text-slate-700' : 'text-slate-400'}>{i.result}</span>
              </div>
            ))}
            {plays.length === 0 && <p className="text-xs text-slate-400">No activity yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminDashboard({ company, ships, users, plays, tab, setTab, onLogout, backLabel = 'Log out', onUpdateMeta, onAddShip, onRemoveShip, onResetShips, onAddPlayer, onBulkImport, onResetPassword, onRemovePlayer, onDeleteCompany, notify }) {
  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-4 border-b bg-white sticky top-0 z-10">
        <div className="flex items-center gap-3">
          {company.logo ? <img src={company.logo} className="h-9 object-contain" /> : <Building2 style={{ color: company.primaryColor }} />}
          <div>
            <div className="font-bold leading-tight">{company.name}</div>
            <div className="text-xs text-slate-400">
              {company.launched ? <span className="text-emerald-600 flex items-center gap-1"><Unlock size={12} />Live</span> : <span className="flex items-center gap-1"><Lock size={12} />Not launched</span>}
            </div>
          </div>
        </div>
        <button onClick={onLogout} className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1"><LogOut size={14} />{backLabel}</button>
      </header>
      <nav className="flex gap-1 px-6 pt-4 border-b bg-white overflow-auto">
        {[['branding', 'Branding'], ['board', 'Board & Prizes'], ['players', 'Players'], ['monitor', 'Live Monitor']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`px-4 py-2 text-sm font-medium rounded-t-lg whitespace-nowrap ${tab === id ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>
            {label}
          </button>
        ))}
      </nav>
      <div className="max-w-4xl mx-auto p-6">
        {tab === 'branding' && <BrandingTab company={company} onUpdateMeta={onUpdateMeta} onDeleteCompany={onDeleteCompany} />}
        {tab === 'board' && <BoardTab company={company} ships={ships} onUpdateMeta={onUpdateMeta} onAddShip={onAddShip} onRemoveShip={onRemoveShip} onResetShips={onResetShips} notify={notify} />}
        {tab === 'players' && <PlayersTab users={users} onAddPlayer={onAddPlayer} onBulkImport={onBulkImport} onResetPassword={onResetPassword} onRemovePlayer={onRemovePlayer} notify={notify} />}
        {tab === 'monitor' && <MonitorTab company={company} ships={ships} users={users} plays={plays} />}
      </div>
    </div>
  );
}

function PlatformDashboard({ companies, managers, onLogout, onManage, onDeleteCompany, onCreateCampaign, onRemoveManager, notify }) {
  const [tab, setTab] = useState('campaigns');
  const [form, setForm] = useState({ companyName: '', primaryColor: '#0f172a', secondaryColor: '#0ea5e9', managerUsername: '', managerPassword: 'Welcome123' });
  const [busy, setBusy] = useState(false);

  const managerForCompany = (companyId) => managers.find((m) => m.companyId === companyId)?.username;
  const companyName = (companyId) => companies.find((c) => c.id === companyId)?.name;

  async function submitCreate(e) {
    e.preventDefault();
    if (!form.companyName || !form.managerUsername || !form.managerPassword) return;
    setBusy(true);
    await onCreateCampaign(form);
    setBusy(false);
    setForm({ companyName: '', primaryColor: '#0f172a', secondaryColor: '#0ea5e9', managerUsername: '', managerPassword: 'Welcome123' });
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-6 py-4 border-b bg-white sticky top-0 z-10">
        <div className="font-bold leading-tight flex items-center gap-2"><Anchor size={20} />Platform Admin</div>
        <button onClick={onLogout} className="text-sm text-slate-500 hover:text-slate-800 flex items-center gap-1"><LogOut size={14} />Log out</button>
      </header>
      <nav className="flex gap-1 px-6 pt-4 border-b bg-white overflow-auto">
        {[['campaigns', 'Campaigns'], ['managers', 'Managers']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={`px-4 py-2 text-sm font-medium rounded-t-lg whitespace-nowrap ${tab === id ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>
            {label}
          </button>
        ))}
      </nav>
      <div className="max-w-4xl mx-auto p-6">
        {tab === 'campaigns' && (
          <div className="grid md:grid-cols-[320px_1fr] gap-6">
            <div className="bg-white border rounded-xl p-4 space-y-2 h-fit">
              <h4 className="font-semibold text-sm mb-1">Create a campaign</h4>
              <form onSubmit={submitCreate} className="space-y-2">
                <input value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} placeholder="Company / campaign name" className="w-full border rounded-lg px-3 py-2 text-sm" required />
                <div className="flex gap-2">
                  <label className="flex-1 text-xs">Primary
                    <input type="color" value={form.primaryColor} onChange={(e) => setForm({ ...form, primaryColor: e.target.value })} className="w-full h-9 rounded-lg border mt-1" />
                  </label>
                  <label className="flex-1 text-xs">Secondary
                    <input type="color" value={form.secondaryColor} onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })} className="w-full h-9 rounded-lg border mt-1" />
                  </label>
                </div>
                <input value={form.managerUsername} onChange={(e) => setForm({ ...form, managerUsername: e.target.value })} placeholder="Manager username" className="w-full border rounded-lg px-3 py-2 text-sm" required />
                <input value={form.managerPassword} onChange={(e) => setForm({ ...form, managerPassword: e.target.value })} placeholder="Manager temporary password" className="w-full border rounded-lg px-3 py-2 text-sm" required />
                <button disabled={busy} className="w-full py-2 rounded-lg bg-slate-900 text-white text-sm font-semibold disabled:opacity-50">{busy ? 'Creating…' : 'Create campaign'}</button>
              </form>
            </div>
            <div className="bg-white border rounded-xl p-4">
              <h4 className="font-semibold text-sm mb-3">All campaigns ({companies.length})</h4>
              <div className="space-y-2">
                {companies.map((c) => (
                  <div key={c.id} className="flex items-center justify-between text-sm border-b pb-2">
                    <div>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-slate-400 text-xs">
                        {c.launched ? 'Live' : 'Not launched'} · {c.totalShips} ships
                        {managerForCompany(c.id) ? ` · ${managerForCompany(c.id)}` : ''}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => onManage(c.id)} className="px-3 py-1.5 rounded-lg border text-xs font-semibold hover:bg-slate-50">Manage</button>
                      <button onClick={() => onDeleteCompany(c.id)} className="text-slate-400 hover:text-red-600" title="Delete"><Trash2 size={15} /></button>
                    </div>
                  </div>
                ))}
                {companies.length === 0 && <p className="text-xs text-slate-400">No campaigns yet.</p>}
              </div>
            </div>
          </div>
        )}
        {tab === 'managers' && (
          <div className="bg-white border rounded-xl p-4">
            <h4 className="font-semibold text-sm mb-3">All managers ({managers.length})</h4>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-slate-400 border-b"><th className="py-1">Username</th><th>Campaign</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {managers.map((m) => (
                  <tr key={m.id} className="border-b">
                    <td className="py-1.5">{m.username}</td>
                    <td>{companyName(m.companyId) || '—'}</td>
                    <td>{m.mustChange ? <span className="text-amber-600 text-xs">Pending setup</span> : <span className="text-emerald-600 text-xs">Active</span>}</td>
                    <td className="text-right"><button onClick={() => onRemoveManager(m.id)} className="text-slate-400 hover:text-red-600" title="Remove"><Trash2 size={14} /></button></td>
                  </tr>
                ))}
                {managers.length === 0 && <tr><td colSpan={4} className="text-slate-400 text-xs py-3">No managers yet.</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- root app ---------------- */

export default function App() {
  const [screen, setScreen] = useState('landing');
  const [launchedCompanies, setLaunchedCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeCompany, setActiveCompany] = useState(null);
  const [profile, setProfile] = useState(null);
  const [ships, setShips] = useState([]);
  const [players, setPlayers] = useState([]);
  const [plays, setPlays] = useState([]);
  const [cellStates, setCellStates] = useState({});
  const [adminTab, setAdminTab] = useState('branding');
  const [allCompanies, setAllCompanies] = useState([]);
  const [allManagers, setAllManagers] = useState([]);
  const [toast, setToast] = useState(null);

  function notify(msg, type = 'info') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  }

  async function refreshAdminData(companyId) {
    const [s, u, p] = await Promise.all([
      api.getShips(companyId),
      api.getPlayers(companyId),
      api.getPlays(companyId),
    ]);
    setShips(s); setPlayers(u); setPlays(p);
  }

  async function refreshPlayerData(companyId) {
    const [cs, p] = await Promise.all([
      api.getBoardState(companyId),
      api.getPlays(companyId),
    ]);
    setCellStates(cs); setPlays(p);
  }

  async function refreshPlatformData() {
    const [c, m] = await Promise.all([
      api.getAllCompanies(),
      api.getAllManagers(),
    ]);
    setAllCompanies(c); setAllManagers(m);
  }

  useEffect(() => {
    (async () => {
      try {
        setLaunchedCompanies(await api.getLaunchedCompanies());
      } catch (e) {
        console.error('failed to load companies', e);
      }
      const session = await api.getSession();
      if (!session) { setLoading(false); return; }
      try {
        const prof = await api.getMyProfile();
        if (!prof) { setLoading(false); return; }
        setProfile(prof);
        if (prof.role === 'admin') {
          await refreshPlatformData();
          setScreen('platformDash');
        } else {
          const company = await api.getCompanyById(prof.companyId);
          setActiveCompany(company);
          if (prof.role === 'manager') {
            await refreshAdminData(company.id);
            setAdminTab('branding');
            setScreen('adminDash');
          } else if (prof.mustChange) {
            setScreen('playerChangePw');
          } else {
            await refreshPlayerData(company.id);
            setScreen('playerGame');
          }
        }
      } catch (e) {
        console.error('session restore failed', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function openPlayerSelect() {
    try {
      setLaunchedCompanies(await api.getLaunchedCompanies());
    } catch (e) {
      console.error('failed to load companies', e);
    }
    setScreen('playerSelect');
  }

  async function createCompany(form) {
    try {
      let company = await api.signUpAndCreateCompany({
        name: form.name, primaryColor: form.primaryColor, secondaryColor: form.secondaryColor,
        adminUsername: form.adminUsername, adminPassword: form.adminPassword,
      });
      if (form.logo) {
        const url = await api.uploadLogo(company.id, form.logo);
        company = await api.updateCompanyMeta(company.id, { logo: url });
      }
      setProfile(await api.getMyProfile());
      setActiveCompany(company);
      await refreshAdminData(company.id);
      setAdminTab('branding');
      setScreen('adminDash');
      notify('Campaign created! Set up your board next.', 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not create campaign.'), 'error');
    }
  }

  async function adminLogin(username, password) {
    try {
      await api.signInAdmin(username, password);
      const prof = await api.getMyProfile();
      setProfile(prof);
      if (prof.role === 'admin') {
        await refreshPlatformData();
        setScreen('platformDash');
      } else {
        const company = await api.getCompanyById(prof.companyId);
        setActiveCompany(company);
        await refreshAdminData(company.id);
        setScreen('adminDash');
        setAdminTab('branding');
      }
    } catch (e) {
      notify('Incorrect admin username or password.', 'error');
    }
  }

  async function openManageCompany(companyId) {
    try {
      const company = await api.getCompanyById(companyId);
      setActiveCompany(company);
      await refreshAdminData(companyId);
      setAdminTab('branding');
      setScreen('adminDash');
    } catch (e) {
      notify(friendlyError(e, 'Could not open that campaign.'), 'error');
    }
  }

  async function backToPlatformDash() {
    setActiveCompany(null);
    setShips([]); setPlayers([]); setPlays([]);
    await refreshPlatformData();
    setScreen('platformDash');
  }

  async function createManagerCampaignHandler(form) {
    try {
      await api.createManagerCampaign(form);
      await refreshPlatformData();
      notify('Campaign created.', 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not create campaign.'), 'error');
    }
  }

  async function platformDeleteCompanyHandler(companyId) {
    if (!window.confirm('This permanently deletes this campaign, its board, and every player account. This cannot be undone. Continue?')) return;
    try {
      await api.platformDeleteCompany(companyId);
      await refreshPlatformData();
      notify('Campaign deleted.', 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not delete campaign.'), 'error');
    }
  }

  async function removeManagerHandler(profileId) {
    if (!window.confirm('This removes the manager\'s login. Their campaign stays intact. Continue?')) return;
    try {
      await api.removeManager(profileId);
      await refreshPlatformData();
      notify('Manager removed.', 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not remove manager.'), 'error');
    }
  }

  function openCompanyToPlay(id) {
    const c = launchedCompanies.find((c) => c.id === id);
    setActiveCompany(c);
    setScreen('playerLogin');
  }

  async function playerLogin(username, password) {
    try {
      await api.signInPlayer(activeCompany.id, username, password);
      const prof = await api.getMyProfile();
      setProfile(prof);
      if (prof.mustChange) {
        setScreen('playerChangePw');
      } else {
        await refreshPlayerData(activeCompany.id);
        setScreen('playerGame');
      }
    } catch (e) {
      notify('Incorrect username or password.', 'error');
    }
  }

  async function changePassword(newPw) {
    try {
      await api.changeOwnPassword(newPw);
      const prof = await api.getMyProfile();
      setProfile(prof);
      await refreshPlayerData(activeCompany.id);
      setScreen('playerGame');
      notify('Password updated.', 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not update password.'), 'error');
    }
  }

  async function logout() {
    await api.signOut();
    setProfile(null);
    setActiveCompany(null);
    setShips([]); setPlayers([]); setPlays([]); setCellStates({});
    setAllCompanies([]); setAllManagers([]);
    setScreen('landing');
  }

  async function updateCompanyMeta(patch) {
    try {
      let finalPatch = patch;
      if (patch.logo && patch.logo.startsWith('data:')) {
        const url = await api.uploadLogo(activeCompany.id, patch.logo);
        finalPatch = { ...patch, logo: url };
      }
      const updated = await api.updateCompanyMeta(activeCompany.id, finalPatch);
      setActiveCompany(updated);
    } catch (e) {
      notify(friendlyError(e, 'Could not save changes.'), 'error');
    }
  }

  async function addShipHandler(shipDraft) {
    try {
      await api.addShip(activeCompany.id, shipDraft);
      setShips(await api.getShips(activeCompany.id));
      notify('Ship placed.', 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not save ship.'), 'error');
    }
  }

  async function removeShipHandler(shipId) {
    try {
      await api.removeShip(shipId);
      setShips(await api.getShips(activeCompany.id));
    } catch (e) {
      notify(friendlyError(e, 'Could not remove ship.'), 'error');
    }
  }

  async function resetShipsHandler() {
    try {
      await api.resetShips(activeCompany.id);
      setShips([]);
    } catch (e) {
      notify(friendlyError(e, 'Could not reset campaign.'), 'error');
    }
  }

  async function addPlayerHandler(form) {
    try {
      await api.addPlayer(activeCompany.id, form);
      setPlayers(await api.getPlayers(activeCompany.id));
      notify('Player added.', 'success');
    } catch (e) {
      notify(e.message === 'duplicate_username' ? 'That username already exists.' : friendlyError(e, 'Could not add player.'), 'error');
    }
  }

  async function bulkImportHandler(rows) {
    try {
      const results = await api.bulkImportPlayers(activeCompany.id, rows);
      setPlayers(await api.getPlayers(activeCompany.id));
      const added = results.filter((r) => r.status === 'added').length;
      notify(`${added} players imported.`, 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not import CSV.'), 'error');
    }
  }

  async function resetPasswordHandler(profileId) {
    try {
      await api.resetPlayerPassword(activeCompany.id, profileId);
      notify('Password reset to Welcome123.', 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not reset password.'), 'error');
    }
  }

  async function removePlayerHandler(profileId) {
    try {
      await api.removePlayer(activeCompany.id, profileId);
      setPlayers(await api.getPlayers(activeCompany.id));
    } catch (e) {
      notify(friendlyError(e, 'Could not remove player.'), 'error');
    }
  }

  async function deleteCompanyHandler() {
    if (!window.confirm('This permanently deletes this campaign, its board, and every player account. This cannot be undone. Continue?')) return;
    try {
      await api.deleteCompany(activeCompany.id);
      setProfile(null);
      setActiveCompany(null);
      setShips([]); setPlayers([]); setPlays([]); setCellStates({});
      setLaunchedCompanies(await api.getLaunchedCompanies());
      setScreen('landing');
      notify('Campaign deleted.', 'success');
    } catch (e) {
      notify(friendlyError(e, 'Could not delete campaign.'), 'error');
    }
  }

  async function platformDeleteActiveCompanyHandler() {
    if (!window.confirm('This permanently deletes this campaign, its board, and every player account. This cannot be undone. Continue?')) return;
    try {
      await api.platformDeleteCompany(activeCompany.id);
      notify('Campaign deleted.', 'success');
      await backToPlatformDash();
    } catch (e) {
      notify(friendlyError(e, 'Could not delete campaign.'), 'error');
    }
  }

  async function handlePlay(cell, invoiceNumber) {
    const clean = invoiceNumber.trim();
    if (!clean) { notify('Please enter your invoice / reference number.', 'error'); return null; }
    try {
      const res = await api.playMove(activeCompany.id, cell, clean);
      await refreshPlayerData(activeCompany.id);
      return res;
    } catch (e) {
      const msg = String(e.message || '');
      if (msg.includes('invoice_used')) notify('That invoice number has already been used to play.', 'error');
      else notify(friendlyError(e, 'Could not play that move.'), 'error');
      return null;
    }
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-500">Loading…</div>;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium ${toast.type === 'error' ? 'bg-red-600 text-white' : toast.type === 'success' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-white'}`}>
          {toast.msg}
        </div>
      )}

      {screen === 'landing' && <Landing onPlay={openPlayerSelect} onAdmin={() => setScreen('adminAuth')} />}

      {screen === 'playerSelect' && <CompanySelect companies={launchedCompanies} onPick={openCompanyToPlay} onBack={() => setScreen('landing')} />}

      {screen === 'playerLogin' && activeCompany && <PlayerLogin company={activeCompany} onLogin={playerLogin} onBack={() => setScreen('playerSelect')} />}

      {screen === 'playerChangePw' && <ChangePasswordScreen onSubmit={changePassword} />}

      {screen === 'playerGame' && activeCompany && profile && (
        <PlayerGame
          company={activeCompany}
          cellStates={cellStates}
          plays={plays}
          player={profile}
          onLogout={logout}
          onChangePassword={() => setScreen('playerChangePw')}
          onPlay={handlePlay}
        />
      )}

      {screen === 'adminAuth' && <AdminAuth onLogin={adminLogin} onCreate={() => setScreen('adminCreate')} onBack={() => setScreen('landing')} />}

      {screen === 'adminCreate' && <AdminCreate onCreate={createCompany} onBack={() => setScreen('adminAuth')} />}

      {screen === 'adminDash' && activeCompany && (
        <AdminDashboard
          company={activeCompany}
          ships={ships}
          users={players}
          plays={plays}
          tab={adminTab}
          setTab={setAdminTab}
          onLogout={profile?.role === 'admin' ? backToPlatformDash : logout}
          backLabel={profile?.role === 'admin' ? 'Platform Dashboard' : 'Log out'}
          onUpdateMeta={updateCompanyMeta}
          onAddShip={addShipHandler}
          onRemoveShip={removeShipHandler}
          onResetShips={resetShipsHandler}
          onAddPlayer={addPlayerHandler}
          onBulkImport={bulkImportHandler}
          onResetPassword={resetPasswordHandler}
          onRemovePlayer={removePlayerHandler}
          onDeleteCompany={profile?.role === 'admin' ? platformDeleteActiveCompanyHandler : deleteCompanyHandler}
          notify={notify}
        />
      )}

      {screen === 'platformDash' && (
        <PlatformDashboard
          companies={allCompanies}
          managers={allManagers}
          onLogout={logout}
          onManage={openManageCompany}
          onDeleteCompany={platformDeleteCompanyHandler}
          onCreateCampaign={createManagerCampaignHandler}
          onRemoveManager={removeManagerHandler}
          notify={notify}
        />
      )}
    </div>
  );
}
