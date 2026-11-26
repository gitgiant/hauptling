// Running test jobs: elapsed time against the repo's typical run, the step and the latest output line.

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * `t`: a running job from the board ({ claimed_at, expect_s, progress: { step, line, results } | null }).
 * Returns { pct: 0..0.97 or null (no typical time yet), over (past the typical time), label, tip }.
 */
export function testProgress(t, now = Date.now()) {
  const start = t?.claimed_at ? Date.parse(t.claimed_at) : NaN;
  const el = Number.isFinite(start) ? Math.max(0, (now - start) / 1000) : null;
  const expect = t?.expect_s > 0 ? t.expect_s : null;
  const pct = el != null && expect ? Math.min(0.97, el / expect) : null;
  const p = t?.progress || null;
  const step = p?.step === 'install' ? 'installing' : p?.step === 'tests' ? 'testing' : null;
  const label = [
    el != null ? `${mmss(el)}${expect ? ` / ~${mmss(expect)}` : ''}` : null,
    p?.results ? `${p.results} done` : null,
  ].filter(Boolean).join(' · ');
  const tip = [step && p?.line ? `${step}: ${p.line}` : step || p?.line || null, expect ? `typical run ~${mmss(expect)} (median of recent runs)` : 'no earlier runs to compare'].filter(Boolean).join('\n');
  return { pct, over: Boolean(el != null && expect && el > expect), label, tip, line: p?.line || '', step };
}
