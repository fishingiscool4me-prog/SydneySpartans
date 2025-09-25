import React, { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";

/* ===================== GROUPS & DISPLAY ===================== */
/* Light → Heavy + Open (no u65kg) */
const ORDER_GROUPS = ["u60kg", "u75kg", "u85kg", "Open"];
const ARMS = ["Right", "Left"];
const DISPLAY_CLASSES = [
  ...ARMS.map((a) => `Open ${a}`),
  ...ORDER_GROUPS
    .filter((g) => g !== "Open")
    .slice()
    .reverse()
    .flatMap((g) => ARMS.map((a) => `${g} ${a}`)),
];
/* ===================== CONFIG ===================== */
/* Using gviz for fast-refresh CSVs */
const CONFIG = {
  sheets: {
    players: { id: "1oKakYJ_L4kpgw2FrPgRxaZHqa5BKgYXP5drXJ5bAuHw", gid: "1561293575" },
    matches: { id: "16NFals1k03ibhtokiG9HzRe207mpKovxjLRNscDq1KI", gid: "573157689" },
  },
  weightClasses: DISPLAY_CLASSES,
  branding: {
    clubName: "NUAC Armwrestling Club",
    logoUrl: "/logo-nobg.png",          // <-- lives at public/logo.png
    backgroundImage: "/background.jpg", // <-- lives at public/background.jpg
  },
  photos: {
  byPlayerId: {
    // keys MUST match the player IDs in your Players sheet
    aden_w: "/aden_champ.png",
    tristan_c: "/tristan_champ.png",
    wesley_h: "/wesley_champ.png",
    yve_w: "/Yve_Champ_New.jpg",
    luke_a: "/luke_champ.png",
    moses_m: "/moses_champ.png",
  },
  size: 72,   // circle size in the card header
  ring: true, // white ring around the photo
},

  defaultWindowDays: 30,
  livePollMs: 2000,
};

/* gviz (fast) CSV URL */
const csvUrl = ({ id, gid }) =>
  `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`;


/* ===================== HELPERS ===================== */
const trim = (x) => (x ?? "").toString().trim();
const yes = (x) => ["true", "yes", "y", "1"].includes(trim(x).toLowerCase());

async function fetchCsv(url) {
  const bust = url.includes("?") ? "&t=" + Date.now() : "?t=" + Date.now();
  const res = await fetch(url + bust, { cache: "no-store" });
  const text = await res.text();
  return new Promise((resolve, reject) =>
    Papa.parse(text, {
      header: true,
      skipEmptyLines: true,
      complete: (r) => resolve(r.data),
      error: reject,
    })
  );
}

const normKey = (k) => (k ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const normalizeRow = (row) => {
  const out = {};
  Object.entries(row || {}).forEach(([k, v]) => (out[normKey(k)] = v));
  return out;
};
const gv = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj[normKey(k)];
    if (v !== undefined && String(v).trim() !== "") return v;
  }
  return "";
};

/* Parse date/datetime as UTC (supports ISO and M/D/YYYY or D/M/YYYY) */
function parseDateTimeUTC(s) {
  const t = String(s || "").trim();
  if (!t) return null;

  // 1) ISO: 2025-08-22 or 2025-08-22 19:45[:ss]
  let m =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/.exec(t);
  if (m) {
    const [, y, mo, d, hh = "12", mi = "0", ss = "0"] = m;
    return new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss));
  }

  // 2) Slash dates: M/D/YYYY or D/M/YYYY, optional time
  m =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2})(?::(\d{1,2})(?::(\d{1,2}))?)?)?$/.exec(t);
  if (m) {
    let a = +m[1], b = +m[2], y = +m[3];
    // Assume M/D by default; if first part > 12, treat as D/M
    let mo = a > 12 ? b : a;
    let d  = a > 12 ? a : b;
    const hh = +(m[4] ?? 12), mi = +(m[5] ?? 0), ss = +(m[6] ?? 0);
    return new Date(Date.UTC(y, mo - 1, d, hh, mi, ss));
  }

  return null; // unknown format
}


/* ===================== ELIGIBILITY & SEEDING ===================== */
/* Treat "women" the same as "u60kg" for eligibility */
function eligibleClassesFor(player) {
  const raw = String(player.weight_class || "").trim();
  const base = raw.toLowerCase() === "women" ? "u60kg" : raw;

  const baseIdx = ORDER_GROUPS.indexOf(base);
  if (baseIdx === -1) return [];
  const labels = [];
  for (let i = baseIdx; i < ORDER_GROUPS.length; i++) {
    for (const arm of ARMS) labels.push(`${ORDER_GROUPS[i]} ${arm}`);
  }
  return labels;
}

function seedLadders(players, displayClasses) {
  const ladders = Object.fromEntries(displayClasses.map((wc) => [wc, []]));
  players
    .filter((p) => p.active)
    .forEach((p) => {
      const elig = eligibleClassesFor(p);
      elig.forEach((wc) => {
        if (ladders[wc]) ladders[wc].push(p);
      });
    });
  Object.keys(ladders).forEach((wc) => {
    ladders[wc].sort((a, b) => {
      const ar = a.current_rank ? +a.current_rank : Infinity;
      const br = b.current_rank ? +b.current_rank : Infinity;
      if (ar !== br) return ar - br;
      return a.name.localeCompare(b.name);
    });
  });
  return ladders;
}
function indexRanks(arr) {
  const m = new Map();
  arr.forEach((p, i) => m.set(p.id || "row_" + i, i + 1));
  return m;
}

/* ===================== MATCH APPLICATION ===================== */
function applyMatchToLadder(ladder, match) {
  const ids = ladder.map((p) => p.id);
  const wi = ids.indexOf(match.winner_id);
  const li = ids.indexOf(match.loser_id);
  const events = [];
  if (wi !== -1 && li !== -1) {
    if (wi < li) {
      events.push({ type: "defense", winner_id: match.winner_id, loser_id: match.loser_id, jump: 0 });
      return { ladder, events };
    }
    if (wi > li) {
      const moved = ladder[wi];
      const out = ladder.slice();
      out.splice(wi, 1);
      out.splice(li, 0, moved);
      const jump = wi - li;
      events.push({ type: "takeover", winner_id: match.winner_id, loser_id: match.loser_id, jump });
      return { ladder: out, events };
    }
  }
  return { ladder, events };
}

/* ===================== CORE REPLAY ===================== */
function computeLaddersThroughDate(players, matches, displayClasses, cutoff) {
  const ladders = seedLadders(players, displayClasses);
  const lastEventMap = new Map();
  const lastJumpMap = new Map();

  const laddersForArm = (arm) =>
    Object.keys(ladders).filter((wc) => wc.endsWith(` ${arm}`));

  matches
    .map((m) => ({ ...m, _t: parseDateTimeUTC(m._dateTime)?.getTime() ?? 0 }))
    .sort((a, b) => {
      if (a._t !== b._t) return a._t - b._t;
      if ((a._seq ?? Infinity) !== (b._seq ?? Infinity))
        return (a._seq ?? Infinity) - (b._seq ?? Infinity);
      return a._stableKey.localeCompare(b._stableKey);
    })
    .forEach((m) => {
      const when = new Date(m._t || 0);
      if (!m.arm) return;
      if (cutoff && when > cutoff) return;

      for (const wc of laddersForArm(m.arm)) {
        const ladder = ladders[wc];
        if (!ladder) continue;

        const ids = ladder.map((p) => p.id);
        const wi = ids.indexOf(m.winner_id);
        const li = ids.indexOf(m.loser_id);
        if (wi === -1 || li === -1) continue;

        const { ladder: newLadder, events } = applyMatchToLadder(ladder, m);
        ladders[wc] = newLadder;

        events.forEach((e) => {
          const wk = `${wc}:${e.winner_id}`;
          const lk = `${wc}:${e.loser_id}`;
          if (!m._badgeSuppressed) {
            if (e.type === "defense") {
              lastEventMap.set(wk, { type: "defense", when });
              lastJumpMap.delete(wk);
            }
            if (e.type === "takeover") {
              lastEventMap.set(wk, { type: "takeover", when });
              lastJumpMap.set(wk, e.jump || 0);
            }
            lastEventMap.set(lk, { type: "lost", when });
            lastJumpMap.delete(lk);
          }
        });
      }
    });

  const out = {};
  Object.keys(ladders).forEach((wc) => {
    const arr = ladders[wc];
    const ranks = indexRanks(arr);
    out[wc] = arr.map((p) => ({ ...p, rank: ranks.get(p.id) }));
  });

  return { ladders: out, lastEventMap, lastJumpMap };
}

/* ===================== APP ===================== */
export default function App() {
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);

  const [windowDays, setWindowDays] = useState(CONFIG.defaultWindowDays);
  const [showBadges, setShowBadges] = useState(true);
  const liveTimer = useRef(null);

  async function loadAll() {
    const pRows = await fetchCsv(csvUrl(CONFIG.sheets.players));
    const mRows = await fetchCsv(csvUrl(CONFIG.sheets.matches));

    /* ---- Players ---- */
    const p = pRows.map((raw, idx) => {
      const r = normalizeRow(raw);
      let rawId = trim(gv(r, "id", "player id", "player_id"));
      let nm = trim(gv(r, "name", "display name", "display_name"));
      let wc = trim(gv(r, "weight class", "weight_class"));
      let act = trim(gv(r, "active", "currently active?", "currently active")) || "true";
      let sr = trim(gv(r, "starting rank", "current_rank"));

      if (!rawId && !nm && !wc) {
        const vals = Object.values(raw || {});
        rawId = trim(vals[0]);
        nm = trim(vals[1]) || rawId;
        wc = trim(vals[2]);
        act = trim(vals[3] ?? "true");
        sr = trim(vals[4]);
      }

      const safeId =
        rawId ||
        (nm ? nm.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") : "") ||
        `anon_${idx}`;

      return {
        id: safeId,
        name: nm || safeId,
        weight_class: wc,
        active: yes(act),
        current_rank: sr,
      };
    });

    /* ---- Matches (deterministic + Badge? support) ---- */
    const m = mRows
      .map((raw, rowIndex) => {
        const r = normalizeRow(raw);
        let date = trim(gv(r, "date", "DATE"));
        let time = trim(gv(r, "time", "timestamp", "datetime"));
        let seqStr = trim(gv(r, "seq", "order", "sequence"));
        let seq = seqStr && !isNaN(+seqStr) ? +seqStr : undefined;

        let wc = trim(gv(r, "weight class", "weight_class"));
        let win = trim(gv(r, "winner id", "winner_id"));
        let lose = trim(gv(r, "loser id", "loser_id", "looser id", "looser_id"));
        let arm = trim(gv(r, "arm?", "arm")).toLowerCase();

        const badgeCol = trim(gv(r, "badge?", "badge"));
        const badgeSuppressed = badgeCol !== "" && !yes(badgeCol); // explicit FALSE disables

        if (!date && !win && !lose) {
          const vals = Object.values(raw || {});
          date = trim(vals[0]);
          wc = trim(vals[1]);
          win = trim(vals[2]);
          lose = trim(vals[3]);
          arm = trim((vals[4] ?? "").toLowerCase());
        }

        arm = arm.startsWith("l") ? "Left" : arm.startsWith("r") ? "Right" : "";

        const dt = time ? `${date} ${time}` : date;
        const dtParsed = parseDateTimeUTC(dt);

        const stableKey = [
          dtParsed ? dtParsed.toISOString() : "na",
          win,
          lose,
          arm,
          wc,
          String(seq ?? ""),
          String(rowIndex),
        ].join("|");

        return {
          date,
          _dateTime: dt,
          _seq: seq,
          _stableKey: stableKey,
          weight_class: wc,
          winner_id: win,
          loser_id: lose,
          arm,
          _badgeSuppressed: badgeSuppressed,
        };
      })
      .filter((x) => x.date && x.arm);

    setPlayers(p);
    setMatches(m);
  }

  useEffect(() => {
    loadAll();
    return () => {
      if (liveTimer.current) clearInterval(liveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute current ladders and window
  const { nowData, pastData, cutoff } = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (showBadges ? windowDays : 36500));
    const past = computeLaddersThroughDate(players, matches, CONFIG.weightClasses, cutoff);
    const now = computeLaddersThroughDate(players, matches, CONFIG.weightClasses, null);
    return { nowData: now, pastData: past, cutoff };
  }, [players, matches, windowDays, showBadges]);

  const lastEventAt = (wc, id) => nowData.lastEventMap.get(`${wc}:${id}`) || null;
  const limitFor = (wc) => (wc.startsWith("Open") ? 15 : 10);

  /* ---------- UI helpers / style ---------- */
  const green = "#22c55e"; // winner highlight
  const gold = "#f5c542";
  const bgOverlay =
    CONFIG.branding.backgroundImage
      ? `linear-gradient(180deg, rgba(9,12,24,.85) 0%, rgba(9,12,24,.85) 60%, rgba(9,12,24,.9) 100%), url(${CONFIG.branding.backgroundImage})`
      : "#0b132b";

  // Rename u60kg ladder headers to "u60KG and women"
  const prettyClassLabel = (wc) => wc.replace(/^u60kg\b/i, "Women and Men u60kg");

  const pageStyle = {
    minHeight: "100vh",
    background: bgOverlay,
    color: "white",
    padding: 20,
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif",
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
  const headerStyle = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 12,
    flexWrap: "wrap",
  };
  const button = {
    padding: "8px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.18)",
    background: "rgba(255,255,255,.06)",
    color: "white",
    cursor: "pointer",
    backdropFilter: "blur(6px)",
  };
  const pill = {
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.15)",
    background: "rgba(255,255,255,.06)",
    fontSize: 12,
  };
  const gridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 20,
  };
  const cardStyle = {
    borderRadius: 20,
    border: "1px solid rgba(255,255,255,.15)",
    background: "rgba(255,255,255,.06)",
    boxShadow: "0 8px 30px rgba(0,0,0,.35)",
    overflow: "hidden",
  };
  const sectionHead = {
    padding: "12px 14px",
    borderBottom: "1px solid rgba(255,255,255,.12)",
    display: "flex",
    alignItems: "center",
    gap: 10,
  };
  const champWrap = { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 };
  const champImg = {
    width: CONFIG.photos.size,
    height: CONFIG.photos.size,
    borderRadius: "50%",
    objectFit: "cover",
    border: CONFIG.photos.ring ? "2px solid rgba(255,255,255,.65)" : "none",
    boxShadow: "0 0 0 3px rgba(255,255,255,.12)",
  };
  const rowStyle = {
    display: "flex",
    gap: 12,
    padding: "10px 12px",
    alignItems: "center",
  };
  const rankStyle = { width: 28, textAlign: "center", fontWeight: 800, opacity: 0.95 };
  const nameStyle = { fontWeight: 700, letterSpacing: .2 };
  const subStyle = { fontSize: 12, opacity: 0.85 };

  function startLiveMinute() {
    if (liveTimer.current) clearInterval(liveTimer.current);
    let ticks = 0;
    liveTimer.current = setInterval(async () => {
      ticks++;
      await loadAll();
      if (ticks >= 30) {
        clearInterval(liveTimer.current);
        liveTimer.current = null;
      }
    }, CONFIG.livePollMs);
  }

  function photoForPlayer(id) {
    return CONFIG.photos.byPlayerId[id] || "";
  }

  return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        {CONFIG.branding.logoUrl && (
          <img
            src={CONFIG.branding.logoUrl}
            alt="logo"
            width={60}
            height={60}
            style={{ borderRadius: 14, boxShadow: "0 8px 24px rgba(0,0,0,.35)" }}
          />
        )}
        <div>
          <h1 style={{ fontSize: 30, fontWeight: 900, margin: 0, letterSpacing: .3 }}>
            {CONFIG.branding.clubName} – Rankings
          </h1>
          <div style={{ marginTop: 4, opacity: .85, fontSize: 13 }}>
            active members only • competitive rankings • instant updates
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, marginLeft: "auto", alignItems: "center", flexWrap: "wrap" }}>
          <button style={button} onClick={loadAll}>Refresh now</button>
          <button style={button} onClick={startLiveMinute}>Live (1 min)</button>
          <span style={pill}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={showBadges}
                onChange={(e) => setShowBadges(e.target.checked)}
              />
              Show badges
            </label>
          </span>
          <span style={pill}>
            Recent window:
            <input
              type="number"
              min={0}
              value={windowDays}
              onChange={(e) => setWindowDays(Math.max(0, parseInt(e.target.value || "0", 10)))}
              style={{
                width: 64, marginLeft: 6, padding: "4px 8px",
                borderRadius: 8, border: "1px solid rgba(255,255,255,.2)",
                background: "rgba(255,255,255,.06)", color: "white"
              }}
            /> days
          </span>
        </div>
      </div>

      {/* Legend */}
      <div style={{ marginBottom: 12, opacity: 0.95, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
        <span style={pill}><span title="Took rank" style={{ color: gold }}>★</span> takeover</span>
        <span style={pill}><span title="Defended">🛡️</span> defense</span>
        <span style={pill}><span title="Upward jump" style={{ color: "#22c55e" }}>↑</span> positions gained</span>
        <span style={{ opacity: .8, fontSize: 12 }}>(badges show only within the chosen window)</span>
      </div>

      <div style={gridStyle}>
        {CONFIG.weightClasses.map((wc) => {
          const current = (nowData.ladders[wc] || []).slice(0, limitFor(wc));
          const past = pastData.ladders[wc] || [];
          const pastRank = new Map(past.map((p) => [p.id, p.rank]));
          const champion = current[0];
          const champPhoto = champion ? photoForPlayer(champion.id) : "";

          return (
            <section key={wc} style={cardStyle}>
              <div style={sectionHead}>
                <strong style={{ fontSize: 16, letterSpacing: .3 }}>{prettyClassLabel(wc)}</strong>
                {champion && (
                  <div style={champWrap} title={`Current #1: ${champion.name}`}>
                    <span style={{ fontSize: 12, opacity: .85, marginRight: 4 }}>Champion</span>
                    {champPhoto ? (
                      <img src={champPhoto} alt={`${champion.name}`} style={champImg} />
                    ) : (
                      <div
                        style={{
                          ...champImg, display: "grid", placeItems: "center",
                          background: "rgba(255,255,255,.08)"
                        }}
                      >
                        <span style={{ fontSize: 11, opacity: .8 }}>No photo</span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div style={{ padding: 10 }}>
                {current.map((p) => {
                  const was = pastRank.get(p.id);
                  const delta = was ? was - p.rank : 0;
                  const evt = lastEventAt(wc, p.id);
                  const showBadge = showBadges && evt && evt.when >= cutoff;

                  const isRecentTakeover = showBadge && evt?.type === "takeover";
                  const isRecentDefense = showBadge && evt?.type === "defense";

                  const jump = nowData.lastJumpMap.get(`${wc}:${p.id}`) ?? 0;
                  const nameColor = isRecentTakeover || isRecentDefense ? "#22c55e" : "white";

                  return (
                    <div key={`${wc}:${p.id}`} style={rowStyle}>
                      <div style={rankStyle}>{p.rank}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={{ ...nameStyle, color: nameColor }}>{p.name}</span>
                          {isRecentTakeover && (jump > 0 || delta > 0) && (
                            <span title={`Up ${jump > 0 ? jump : delta}`} style={{ color: "#22c55e", fontWeight: 800 }}>
                              ↑ {jump > 0 ? jump : delta}
                            </span>
                          )}
                          {isRecentTakeover && <span title="Took rank" style={{ color: "#f5c542" }}>★</span>}
                          {isRecentDefense && <span title="Defended">🛡️</span>}
                        </div>
                        <div style={subStyle}>Base: {p.weight_class}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
