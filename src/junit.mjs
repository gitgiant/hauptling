/** Minimal JUnit XML reader: counts and failures, enough for a test report. */

const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unescape(m[1]) : ''; };
const strip = (s) => unescape(s.replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim();

export function parseJunit(xml) {
  const out = { passed: 0, failed: 0, skipped: 0, failures: [] };
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const open = `<testcase${m[1]}>`;
    const body = m[3] || '';
    const name = [attr(open, 'classname'), attr(open, 'name')].filter(Boolean).join(' › ');
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    if (fail) {
      out.failed++;
      const text = strip(fail[3] || '');
      const message = (attr(`<x${fail[2]}>`, 'message') || text.split('\n')[0] || 'failed').slice(0, 300);
      const loc = attr(open, 'file') ? `${attr(open, 'file')}${attr(open, 'line') ? `:${attr(open, 'line')}` : ''}` : (/(\S+\.\w+:\d+(?::\d+)?)/.exec(text)?.[1] || '');
      out.failures.push({ test_id: name, loc, message, excerpt: text.split('\n').slice(0, 20).join('\n') });
    } else if (/<skipped\b/.test(body)) out.skipped++;
    else out.passed++;
  }
  return out;
}
