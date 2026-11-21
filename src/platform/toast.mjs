/*
 * Windows toast XML that acts like AskUserQuestion: up to 4 choice buttons plus "Other…".
 * Buttons open http://127.0.0.1 links to the broker's answer page (Windows forwards localhost
 * into WSL), so no URL protocol registration is needed.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function toastXml({ title, body, choices = [], links }) {
  const visual = `<visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual>`;
  if (!links) return `<toast scenario="reminder">${visual}<actions><action content="Dismiss" activationType="system" arguments="dismiss"/></actions></toast>`;
  const button = (label, url) => `<action content="${esc(label)}" activationType="protocol" arguments="${esc(url)}"/>`;
  const actions = choices.slice(0, 4).map((c, i) => button(c.slice(0, 40), links.choice(i))).join('') + button('Other…', links.page);
  return `<toast scenario="reminder" activationType="protocol" launch="${esc(links.page)}">`
    + visual
    + `<actions>${actions}</actions></toast>`;
}
