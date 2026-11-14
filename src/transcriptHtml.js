// Pure HTML renderer for ticket transcripts. No Discord imports, so it is easy to test.
// Input messages are plain objects produced by transcript.js:
//   { id, authorId, authorName, avatar, bot, ts, content, attachments[], embeds[], stickers[] }

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Inline markdown on already-escaped text. */
function inline(escaped) {
  // Links are cut out first so markdown characters inside a URL (like __ or *) stay untouched.
  return escaped
    .split(/(https?:\/\/[^\s<]+)/g)
    .map((part, index) =>
      index % 2
        ? `<a href="${part}" target="_blank" rel="noopener noreferrer">${part}</a>`
        : markdown(part),
    )
    .join('')
    .replace(/\n/g, '<br>');
}

function markdown(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
    .replace(/__([^_\n]+)__/g, '<u>$1</u>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
}

/** Code blocks and inline code are split out first so markdown inside them stays literal. */
function formatContent(raw) {
  return String(raw ?? '')
    .split(/(```[\s\S]*?```|`[^`\n]+`)/g)
    .map((part) => {
      if (part.length >= 6 && part.startsWith('```') && part.endsWith('```')) {
        const body = part.slice(3, -3).replace(/^[a-z0-9+#-]*\n/i, '');
        return `<pre>${esc(body)}</pre>`;
      }
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`')) {
        return `<code>${esc(part.slice(1, -1))}</code>`;
      }
      return inline(esc(part));
    })
    .join('');
}

const formatTime = (ms) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
const formatSeconds = (s) => (s ? formatTime(s * 1000) : '—');

function renderEmbed(e) {
  const parts = [];
  if (e.title) parts.push(`<div class="et">${esc(e.title)}</div>`);
  if (e.description) parts.push(`<div>${formatContent(e.description)}</div>`);
  for (const f of e.fields ?? []) {
    parts.push(`<div class="ef"><b>${esc(f.name)}</b><br>${formatContent(f.value)}</div>`);
  }
  if (!parts.length) return '';
  const color = /^#[0-9a-f]{6}$/i.test(e.color ?? '') ? e.color : '#4f545c';
  return `<div class="embed" style="border-left-color:${color}">${parts.join('')}</div>`;
}

function renderAttachment(a) {
  const name = esc(a.name);
  const url = esc(a.url);
  if (a.image) {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer"><img class="att" src="${url}" alt="${name}" loading="lazy"></a>`;
  }
  return `<div class="file">📎 <a href="${url}" target="_blank" rel="noopener noreferrer">${name}</a></div>`;
}

const GROUP_WINDOW_MS = 7 * 60 * 1000;

function renderMessages(messages) {
  const html = [];
  let prev = null;

  for (const m of messages) {
    const grouped = prev && prev.authorId === m.authorId && m.ts - prev.ts < GROUP_WINDOW_MS;
    prev = m;

    const body = [];
    if (m.content) body.push(`<div class="txt">${formatContent(m.content)}</div>`);
    for (const a of m.attachments ?? []) body.push(renderAttachment(a));
    for (const e of m.embeds ?? []) body.push(renderEmbed(e));
    for (const s of m.stickers ?? []) body.push(`<div class="file">🏷️ Sticker: ${esc(s)}</div>`);
    if (!body.length) continue;

    if (grouped) {
      html.push(
        `<div class="msg cont" id="m${esc(m.id)}"><div class="gutter" title="${formatTime(m.ts)}"></div><div class="body">${body.join('')}</div></div>`,
      );
    } else {
      const badge = m.bot ? '<span class="bot">BOT</span>' : '';
      html.push(
        `<div class="msg" id="m${esc(m.id)}">` +
          `<img class="av" src="${esc(m.avatar)}" alt="" loading="lazy">` +
          `<div class="body"><div class="head"><span class="name">${esc(m.authorName)}</span>${badge}` +
          `<span class="time">${formatTime(m.ts)}</span></div>${body.join('')}</div></div>`,
      );
    }
  }
  return html.join('\n');
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#313338;color:#dbdee1;font:15px/1.45 "gg sans","Segoe UI",system-ui,sans-serif}
header{padding:20px 24px;background:#2b2d31;border-bottom:1px solid #1e1f22}
header h1{margin:0 0 6px;font-size:20px;color:#fff}
header dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 14px;margin:0;font-size:13px;color:#b5bac1}
header dt{font-weight:600}header dd{margin:0}
main{padding:16px 24px 40px;max-width:980px;margin:0 auto}
.msg{display:flex;gap:14px;padding:3px 0;margin-top:14px}
.msg.cont{margin-top:0}
.av{width:40px;height:40px;border-radius:50%;flex:none}
.gutter{width:40px;flex:none}
.body{min-width:0;flex:1}
.head{display:flex;align-items:baseline;gap:8px}
.name{font-weight:600;color:#fff}
.time{font-size:11px;color:#949ba4}
.bot{background:#5865f2;color:#fff;font-size:10px;border-radius:3px;padding:0 4px}
.txt{word-wrap:break-word;overflow-wrap:anywhere}
a{color:#00a8fc}
code{background:#1e1f22;border-radius:3px;padding:1px 4px;font-size:13px}
pre{background:#1e1f22;border:1px solid #1a1b1e;border-radius:4px;padding:8px;overflow:auto;margin:4px 0;white-space:pre-wrap}
.att{max-width:420px;max-height:320px;border-radius:6px;margin-top:4px;display:block}
.file{margin-top:4px;font-size:13px}
.embed{border-left:4px solid #4f545c;background:#2b2d31;border-radius:4px;padding:8px 12px;margin-top:4px;max-width:520px}
.et{font-weight:600;color:#fff;margin-bottom:4px}
.ef{margin-top:6px;font-size:13px}
.note{margin:14px 0;padding:8px 12px;background:#4a3b12;border-radius:4px;color:#fee75c;font-size:13px}
footer{text-align:center;color:#6d6f78;font-size:12px;padding:20px}
`;

function renderTranscript({ guildName, ticket, ownerName, messages, truncated = false, generatedAt = Date.now() }) {
  const number = String(ticket.number).padStart(4, '0');
  const rows = [
    ['Server', guildName],
    ['Opened by', ownerName || ticket.owner_id],
    ['Opened', formatSeconds(ticket.created_at)],
    ['Closed', formatSeconds(ticket.closed_at)],
    ['Messages', String(messages.length)],
  ];
  if (ticket.subject) rows.splice(2, 0, ['Subject', ticket.subject]);
  if (ticket.close_reason) rows.push(['Close reason', ticket.close_reason]);

  const note = truncated
    ? '<div class="note">This ticket is very long, so only the most recent messages are included.</div>'
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ticket #${number} transcript</title>
<style>${CSS}</style></head>
<body>
<header><h1>Ticket #${number} transcript</h1><dl>
${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('\n')}
</dl></header>
<main>${note}
${renderMessages(messages)}
</main>
<footer>Generated ${formatTime(generatedAt)}</footer>
</body></html>`;
}

module.exports = { renderTranscript, formatContent, esc };
