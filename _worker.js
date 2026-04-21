import { connect } from 'cloudflare:sockets';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/api/send' && request.method === 'POST') {
      try {
        const data = await request.json();
        await smtpSend(data);
        return Response.json({ ok: true }, { headers: CORS });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/api/fetch' && request.method === 'POST') {
      try {
        const data = await request.json();
        const emails = await imapFetch(data);
        return Response.json({ ok: true, emails }, { headers: CORS });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: CORS });
      }
    }

    if (url.pathname === '/api/test-smtp' && request.method === 'POST') {
      try {
        const data = await request.json();
        await smtpTest(data);
        return Response.json({ ok: true }, { headers: CORS });
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 500, headers: CORS });
      }
    }

    const resp = await env.ASSETS.fetch(request);
    const newHeaders = new Headers(resp.headers);
    newHeaders.set('Cache-Control', 'no-store');
    return new Response(resp.body, { status: resp.status, headers: newHeaders });
  }
};

/* ================================================================
   SMTP
   ================================================================ */

async function smtpSend({ smtpHost, smtpPort, smtpEnc, user, pass, from, to, cc, subject, html }) {
  smtpPort = parseInt(smtpPort) || 587;
  const directTls = smtpEnc === 'ssl' || smtpPort === 465;
  const socketOpts = directTls ? { secureTransport: 'on' } : { secureTransport: 'starttls' };

  let socket = connect(`${smtpHost}:${smtpPort}`, socketOpts);
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';

  async function readLine() {
    while (!buf.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP: Verbindung unterbrochen');
      buf += dec.decode(value);
    }
    const nl = buf.indexOf('\n');
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    return line;
  }

  async function readResponse() {
    let line;
    do {
      line = await readLine();
    } while (line.length >= 4 && line[3] === '-'); // multi-line
    const code = parseInt(line.slice(0, 3));
    if (code >= 400) throw new Error(`SMTP ${code}: ${line.slice(4)}`);
    return line;
  }

  async function cmd(c) {
    await writer.write(enc.encode(c + '\r\n'));
    return readResponse();
  }

  // Greeting
  await readResponse();

  // EHLO + check STARTTLS capability
  await writer.write(enc.encode('EHLO mail-app\r\n'));
  const ehloLines = [];
  let eLine;
  do {
    eLine = await readLine();
    ehloLines.push(eLine);
  } while (eLine.length >= 4 && eLine[3] === '-');
  const ehloCode = parseInt(eLine.slice(0, 3));
  if (ehloCode >= 400) throw new Error(`SMTP EHLO: ${eLine}`);

  // STARTTLS upgrade if needed
  if (!directTls) {
    const hasStls = ehloLines.some(l => l.toUpperCase().includes('STARTTLS'));
    if (hasStls) {
      await cmd('STARTTLS');
      reader.releaseLock();
      writer.releaseLock();
      const tlsSock = socket.startTls();
      reader = tlsSock.readable.getReader();
      writer = tlsSock.writable.getWriter();
      buf = '';
      // Re-EHLO after upgrade
      await writer.write(enc.encode('EHLO mail-app\r\n'));
      let l2;
      do { l2 = await readLine(); } while (l2.length >= 4 && l2[3] === '-');
      if (parseInt(l2.slice(0, 3)) >= 400) throw new Error(`SMTP EHLO(TLS): ${l2}`);
    }
  }

  // AUTH LOGIN
  await cmd('AUTH LOGIN');
  await writer.write(enc.encode(btoa(user) + '\r\n'));
  await readResponse();
  await writer.write(enc.encode(btoa(pass) + '\r\n'));
  await readResponse();

  // Envelope
  await cmd(`MAIL FROM:<${from}>`);
  const rcpts = [...to.split(','), ...(cc ? cc.split(',') : [])]
    .map(s => s.trim()).filter(Boolean);
  for (const r of rcpts) await cmd(`RCPT TO:<${r}>`);

  // Build MIME message
  await cmd('DATA');
  const boundary = `MP_${Date.now().toString(36)}`;
  const msgId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@jsmedia>`;
  const plain = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${mimeHdr(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${msgId}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean).join('\r\n');

  const body =
    `--${boundary}\r\n` +
    `Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    wrap76(b64utf8(plain)) + `\r\n\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    wrap76(b64utf8(html)) + `\r\n\r\n` +
    `--${boundary}--`;

  await writer.write(enc.encode(headers + '\r\n\r\n' + body + '\r\n.\r\n'));
  await readResponse();
  await cmd('QUIT');
}

/* ================================================================
   SMTP TEST (auth only, no message sent)
   ================================================================ */

async function smtpTest({ smtpHost, smtpPort, smtpEnc, user, pass }) {
  smtpPort = parseInt(smtpPort) || 587;
  const directTls = smtpEnc === 'ssl' || smtpPort === 465;
  const socketOpts = directTls ? { secureTransport: 'on' } : { secureTransport: 'starttls' };

  let socket = connect(`${smtpHost}:${smtpPort}`, socketOpts);
  let reader = socket.readable.getReader();
  let writer = socket.writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';

  async function readLine() {
    while (!buf.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SMTP: Verbindung unterbrochen');
      buf += dec.decode(value);
    }
    const nl = buf.indexOf('\n');
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    return line;
  }

  async function readResponse() {
    let line;
    do { line = await readLine(); } while (line.length >= 4 && line[3] === '-');
    const code = parseInt(line.slice(0, 3));
    if (code >= 400) throw new Error(`SMTP ${code}: ${line.slice(4)}`);
    return line;
  }

  async function cmd(c) {
    await writer.write(enc.encode(c + '\r\n'));
    return readResponse();
  }

  await readResponse(); // greeting

  await writer.write(enc.encode('EHLO mail-app\r\n'));
  const ehloLines = [];
  let eLine;
  do {
    eLine = await readLine();
    ehloLines.push(eLine);
  } while (eLine.length >= 4 && eLine[3] === '-');
  if (parseInt(eLine.slice(0, 3)) >= 400) throw new Error(`SMTP EHLO: ${eLine}`);

  if (!directTls) {
    if (ehloLines.some(l => l.toUpperCase().includes('STARTTLS'))) {
      await cmd('STARTTLS');
      reader.releaseLock();
      writer.releaseLock();
      const tlsSock = socket.startTls();
      reader = tlsSock.readable.getReader();
      writer = tlsSock.writable.getWriter();
      buf = '';
      await writer.write(enc.encode('EHLO mail-app\r\n'));
      let l2;
      do { l2 = await readLine(); } while (l2.length >= 4 && l2[3] === '-');
      if (parseInt(l2.slice(0, 3)) >= 400) throw new Error(`SMTP EHLO(TLS): ${l2}`);
    }
  }

  await cmd('AUTH LOGIN');
  await writer.write(enc.encode(btoa(user) + '\r\n'));
  await readResponse();
  await writer.write(enc.encode(btoa(pass) + '\r\n'));
  await readResponse(); // 235 = auth success, throws on failure

  await cmd('QUIT');
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function wrap76(b64) {
  return (b64.match(/.{1,76}/g) ?? [b64]).join('\r\n');
}

function mimeHdr(str) {
  if (!/[^\x20-\x7E]/.test(str)) return str;
  return `=?UTF-8?B?${b64utf8(str)}?=`;
}

/* ================================================================
   IMAP
   ================================================================ */

async function imapFetch({ imapHost, imapPort, user, pass, limit = 25 }) {
  imapPort = parseInt(imapPort) || 993;
  const socket = connect(`${imapHost}:${imapPort}`, { secureTransport: 'on' });
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';
  let tagN = 0;

  async function fillBuf(predicate) {
    while (!predicate(buf)) {
      const { value, done } = await reader.read();
      if (done) throw new Error('IMAP: Verbindung unterbrochen');
      buf += dec.decode(value);
    }
  }

  async function cmd(command) {
    const tag = `M${String(++tagN).padStart(3, '0')}`;
    await writer.write(enc.encode(`${tag} ${command}\r\n`));
    // Read until we see "TAG OK/NO/BAD"
    const re = new RegExp(`\\n${tag} (OK|NO|BAD)[^\\r\\n]*\\r?\\n`);
    await fillBuf(b => re.test(b));
    const m = buf.match(re);
    const endIdx = buf.indexOf(m[0]) + m[0].length;
    const result = buf.slice(0, endIdx);
    buf = buf.slice(endIdx);
    if (m[1] !== 'OK') throw new Error(`IMAP ${tag}: ${m[0].trim()}`);
    return result;
  }

  // Greeting
  await fillBuf(b => b.includes('\r\n'));
  buf = '';

  // Login
  await cmd(`LOGIN "${escImap(user)}" "${escImap(pass)}"`);

  // Select INBOX
  const sel = await cmd('SELECT INBOX');
  const existsM = sel.match(/\* (\d+) EXISTS/);
  const total = existsM ? parseInt(existsM[1]) : 0;

  if (total === 0) { await cmd('LOGOUT'); return []; }

  const fromSeq = Math.max(1, total - limit + 1);

  const fetchResp = await cmd(
    `FETCH ${fromSeq}:${total} (UID FLAGS INTERNALDATE ` +
    `BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)] ` +
    `BODY.PEEK[TEXT]<0.512>)`
  );

  await cmd('LOGOUT');
  return parseImapFetch(fetchResp);
}

function escImap(s) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseImapFetch(resp) {
  const emails = [];
  // Split on untagged FETCH messages
  const parts = resp.split(/(?=\r\n\* \d+ FETCH|\A\* \d+ FETCH)/).map(p => p.replace(/^\r\n/, ''));

  for (const part of parts) {
    if (!/^\* \d+ FETCH/.test(part)) continue;
    const seqM = part.match(/^\* (\d+) FETCH/);
    if (!seqM) continue;

    const flagsM = part.match(/FLAGS \(([^)]*)\)/);
    const unread = flagsM ? !flagsM[1].includes('\\Seen') : true;

    const dateM = part.match(/INTERNALDATE "([^"]+)"/);
    const date = dateM ? fmtImapDate(dateM[1]) : '';

    // Header block: BODY[HEADER.FIELDS (...)] {N}\r\n<block>
    const hdrM = part.match(/BODY\[HEADER\.FIELDS[^\]]*\]\s+\{\d+\}\r\n([\s\S]*?)(?=\s+BODY\[TEXT\]|\s+\))/);
    let fromName = '', fromAddr = '', subject = '', msgId = '';
    if (hdrM) {
      const h = hdrM[1];
      const fM = h.match(/^From:\s*(.+)/im);
      const sM = h.match(/^Subject:\s*([\s\S]+?)(?=\r?\n\S|\r?\n\r?\n|$)/im);
      const iM = h.match(/^Message-ID:\s*(.+)/im);
      if (fM) ({ name: fromName, email: fromAddr } = parseAddr(fM[1].trim()));
      if (sM) subject = mimeDecHdr(sM[1].replace(/\r?\n\s+/g, ' ').trim());
      if (iM) msgId = iM[1].trim();
    }

    // Text preview: BODY[TEXT]<0> {N}\r\n<content>
    const txtM = part.match(/BODY\[TEXT\]<0>\s+\{\d+\}\r\n([\s\S]*?)(?=\r\n\)|\r\nM\d)/);
    let preview = '';
    if (txtM) {
      let raw = txtM[1];
      // Try base64 decode
      const b64Candidate = raw.replace(/\r\n/g, '');
      if (/^[A-Za-z0-9+/=]+$/.test(b64Candidate) && b64Candidate.length > 20) {
        try { raw = atob(b64Candidate); } catch { /* not b64 */ }
      }
      preview = raw
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    }

    emails.push({
      id: `imap_${seqM[1]}_${Date.now()}${Math.floor(Math.random() * 999)}`,
      _imapSeq: parseInt(seqM[1]),
      _msgId: msgId || null,
      folder: 'inbox',
      from: fromName || fromAddr || '(Unbekannt)',
      email: fromAddr,
      subject: subject || '(Kein Betreff)',
      preview: preview || '…',
      date,
      unread,
      body: `<p style="font-family:Inter,sans-serif;font-size:14px;color:#7a766f;font-style:italic;padding:24px">Volltext nicht geladen.</p>`,
      starColor: null,
      account: 'work',
      _remote: true,
    });
  }

  return emails.sort((a, b) => b._imapSeq - a._imapSeq);
}

function fmtImapDate(s) {
  try {
    const d = new Date(s.replace(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/, '$2 $1 $3'));
    const now = new Date();
    if (d.toDateString() === now.toDateString())
      return 'Heute, ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    if (d.toDateString() === yest.toDateString()) return 'Gestern';
    return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
  } catch { return s; }
}

function parseAddr(addr) {
  addr = addr.replace(/\r?\n\s+/g, ' ').trim();
  const m = addr.match(/^"?([^"<>]+?)"?\s*<([^>]+)>/);
  if (m) return { name: mimeDecHdr(m[1].trim()), email: m[2].trim() };
  const e = addr.match(/<?([^\s<>]+@[^\s<>]+)>?/);
  return { name: '', email: e ? e[1] : addr };
}

function mimeDecHdr(s) {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, charset, enc, text) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
      } else {
        const qp = text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
        bytes = new TextEncoder().encode(qp);
      }
      return new TextDecoder(charset).decode(bytes);
    } catch { return text; }
  });
}
