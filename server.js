require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(lineConfig);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CARDS = {
  'Krungsri Plat': { cut: 5,  due: 25 },
  'FC':            { cut: 8,  due: 28 },
  'KBank Plat':    { cut: 10, due: 25 },
  'Line':          { cut: 10, due: 25 },
  'UOB':           { cut: 7,  due: 25 },
  'CardX':         { cut: 16, due: 5  },
  'ShopeePay':     { cut: null, due: 10 },
  'the1':          { cut: 10, due: 30 },
  'homepro':       { cut: 25, due: 14 },
  'Now':           { cut: 5,  due: 25 },
};

const REMINDER_OFFSETS = [3];

const COMMANDS = ['ดูบิล', 'ดูทั้งหมด', 'สรุป', 'ช่วยเหลือ', 'help', 'all', 'summary', 'เพิ่มบิล', 'add'];

// ── Express app ─────────────────────────────────────────────────────────────

const app = express();

app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  res.sendStatus(200);
  Promise.all((req.body.events || []).map(handleEvent)).catch(err =>
    console.error('webhook error', err)
  );
});

app.use((err, req, res, next) => {
  if (err instanceof line.SignatureValidationFailed)
    return res.status(401).send('signature validation failed');
  if (err instanceof line.JSONParseError)
    return res.status(400).send('invalid request body');
  next(err);
});

// ── Event router ─────────────────────────────────────────────────────────────

async function handleEvent(event) {
  const userId = event.source?.userId;
  if (!userId) return;

  if (event.type === 'follow') {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ยินดีต้อนรับสู่ Bill Tracker 🧾\n\nส่งรูปบิลมาได้เลย บอทจะอ่านและช่วยบันทึกให้\n\nพิมพ์ "ช่วยเหลือ" เพื่อดูคำสั่งทั้งหมด',
    });
  }

  if (event.type === 'postback') {
    return handlePostback(event, userId);
  }

  if (event.type !== 'message') return;

  const session = await db.getSession(userId);

  if (event.message.type === 'image') {
    return handleImage(event, userId);
  }

  if (event.message.type === 'text') {
    return handleText(event, userId, session);
  }
}

// ── Image handler ─────────────────────────────────────────────────────────────

async function handleImage(event, userId) {
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: 'รับรูปแล้ว กำลังอ่าน... 🔍',
  });

  let base64;
  try {
    const stream = await client.getMessageContent(event.message.id);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    base64 = Buffer.concat(chunks).toString('base64');
  } catch (e) {
    console.error('download image failed', e);
    await client.pushMessage(userId, { type: 'text', text: 'ดาวน์โหลดรูปไม่ได้ ลองส่งใหม่อีกครั้ง' });
    return;
  }

  let billData = { store: null, date: null, items: [], total: 0 };
  try {
    billData = await extractBillData(base64);
  } catch (e) {
    console.error('OCR failed status:', e.status, 'message:', e.message, 'error:', JSON.stringify(e.error));
  }

  const today = new Date().toISOString().split('T')[0];
  const bill = {
    id: randomId(),
    store: billData.store || '',
    date: billData.date || today,
    items: billData.items || [],
    disc: billData.disc_pct || 0,
    sc: billData.sc_pct || 0,
    vat: billData.vat_pct || 0,
    grand: billData.total || 0,
    card: '',
    installMonths: 0,
    persons: [],
    personTotals: {},
    paid: false,
    paidMonths: [],
  };

  await db.setSession(userId, 'set_store', { bill });

  const lines = ['อ่านบิลเสร็จ ✓', ''];
  lines.push(bill.store ? `🏪 ร้าน: ${bill.store}` : '🏪 ร้าน: (อ่านไม่ได้)');
  if (bill.grand) lines.push(`💰 ยอด: ${fmt(bill.grand)} บาท`);
  if (bill.items.length) {
    lines.push('');
    bill.items.slice(0, 4).forEach(it => lines.push(`  • ${it.name}`));
    if (bill.items.length > 4) lines.push(`  ...และอีก ${bill.items.length - 4} รายการ`);
  }
  lines.push('', 'ชื่อร้านถูกต้องไหม?', '(พิมพ์ชื่อร้านเพื่อแก้ไข หรือกด ✓)');

  await client.pushMessage(userId, {
    type: 'text',
    text: lines.join('\n'),
    quickReply: {
      items: [
        qr('✓ ถูกต้อง', '✓ ถูกต้อง'),
        qr('✗ ยกเลิก', '✗ ยกเลิก'),
      ],
    },
  });
}

// ── Text handler ──────────────────────────────────────────────────────────────

async function handleText(event, userId, session) {
  const text = event.message.text.trim();

  if (text === '✗ ยกเลิก' || text === 'ยกเลิก') {
    await db.clearSession(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: 'ยกเลิกแล้ว' });
  }

  if (session.state !== 'idle' && COMMANDS.includes(text.toLowerCase())) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'กำลังบันทึกบิลอยู่ พิมพ์ "ยกเลิก" เพื่อหยุดก่อน',
    });
  }

  switch (session.state) {
    case 'set_store':   return handleSetStore(event, userId, session, text);
    case 'set_amount':  return handleSetAmount(event, userId, session, text);
    case 'set_card':    return handleSetCard(event, userId, session, text);
    case 'set_install': return handleSetInstall(event, userId, session, text);
    case 'add_persons': return handleAddPersons(event, userId, session, text);
    case 'confirm':     return handleConfirm(event, userId, session, text);
    default:            return handleIdle(event, userId, text);
  }
}

// ── Idle ──────────────────────────────────────────────────────────────────────

async function handleIdle(event, userId, text) {
  const lower = text.toLowerCase();

  if (lower === 'ดูบิล' || lower === 'บิล') {
    const { bills } = await db.getUserData(userId);
    const unpaid = bills.filter(b => !b.paid);
    if (!unpaid.length) {
      return client.replyMessage(event.replyToken, {
        type: 'text',
        text: 'ไม่มีบิลค้างจ่าย 🎉\n(พิมพ์ "ดูทั้งหมด" เพื่อดูบิลที่จ่ายแล้วด้วย)',
      });
    }
    return client.replyMessage(event.replyToken, buildBillListFlex([...unpaid].reverse().slice(0, 10)));
  }

  if (lower === 'ดูทั้งหมด' || lower === 'all') {
    const { bills } = await db.getUserData(userId);
    if (!bills.length) return client.replyMessage(event.replyToken, { type: 'text', text: 'ยังไม่มีบิล' });
    return client.replyMessage(event.replyToken, buildBillListFlex([...bills].reverse().slice(0, 10)));
  }

  if (lower === 'สรุป' || lower === 'summary') {
    const { bills } = await db.getUserData(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: buildStatsText(bills) });
  }

  if (lower === 'myid' || lower === 'userid') {
    return client.replyMessage(event.replyToken, { type: 'text', text: `User ID:\n${userId}` });
  }

  if (lower === 'เพิ่มบิล' || lower === 'add') {
    const today = new Date().toISOString().split('T')[0];
    const bill = {
      id: randomId(), store: '', date: today,
      items: [], disc: 0, sc: 0, vat: 0, grand: 0,
      card: '', installMonths: 0, persons: [],
      personTotals: {}, paid: false, paidMonths: [],
    };
    await db.setSession(userId, 'set_store', { bill });
    return client.replyMessage(event.replyToken, { type: 'text', text: 'ชื่อร้านอะไร?' });
  }

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: 'Bill Tracker 🧾\n\n📸 ส่งรูปบิล → บอทอ่านและบันทึกให้\n➕ "เพิ่มบิล" → กรอกเองทีละขั้น\n📋 "ดูบิล" → บิลค้างจ่าย\n📊 "สรุป" → ยอดรวมแต่ละบัตร\n📂 "ดูทั้งหมด" → บิลทุกรายการ',
    quickReply: {
      items: [
        qr('➕ เพิ่มบิล', 'เพิ่มบิล'),
        qr('📋 ดูบิล', 'ดูบิล'),
        qr('📊 สรุป', 'สรุป'),
        qr('📂 ดูทั้งหมด', 'ดูทั้งหมด'),
      ],
    },
  });
}

// ── State: set_store ──────────────────────────────────────────────────────────

async function handleSetStore(event, userId, session, text) {
  const bill = { ...session.data.bill };
  if (text !== '✓ ถูกต้อง') bill.store = text || bill.store;
  if (!bill.store) bill.store = '(ไม่ระบุ)';

  if (!bill.grand) {
    await db.setSession(userId, 'set_amount', { bill });
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `ร้าน: ${bill.store} ✓\n\nยอดรวมทั้งหมด (บาท)?`,
    });
  }

  await db.setSession(userId, 'set_card', { bill });
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `ร้าน: ${bill.store} ✓\n\nใช้บัตรอะไร?`,
    quickReply: { items: [...Object.keys(CARDS).map(c => qr(c, c)), qr('ไม่ระบุ', 'ไม่ระบุ')] },
  });
}

async function handleSetAmount(event, userId, session, text) {
  const bill = { ...session.data.bill };
  const amount = parseFloat(text.replace(/[฿,\s]/g, ''));
  if (isNaN(amount) || amount <= 0) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'ใส่ตัวเลขยอดเงิน เช่น 1234.50',
    });
  }
  bill.grand = amount;
  await db.setSession(userId, 'set_card', { bill });
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `ยอด: ${fmt(amount)} ✓\n\nใช้บัตรอะไร?`,
    quickReply: { items: [...Object.keys(CARDS).map(c => qr(c, c)), qr('ไม่ระบุ', 'ไม่ระบุ')] },
  });
}

// ── State: set_card ───────────────────────────────────────────────────────────

async function handleSetCard(event, userId, session, text) {
  const bill = { ...session.data.bill };
  bill.card = CARDS[text] ? text : (text === 'ไม่ระบุ' ? '' : text);

  await db.setSession(userId, 'set_install', { bill });

  const cardLine = bill.card ? `บัตร: ${bill.card} ✓\n\n` : '';
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `${cardLine}ผ่อนกี่เดือน?`,
    quickReply: {
      items: [
        qr('ไม่ผ่อน', '0'),
        qr('3 เดือน', '3'),
        qr('4 เดือน', '4'),
        qr('6 เดือน', '6'),
        qr('10 เดือน', '10'),
      ],
    },
  });
}

// ── State: set_install ────────────────────────────────────────────────────────

async function handleSetInstall(event, userId, session, text) {
  const bill = { ...session.data.bill };
  bill.installMonths = Math.max(0, parseInt(text) || 0);

  const { knownPersons } = await db.getUserData(userId);
  await db.setSession(userId, 'add_persons', { bill, knownPersons });

  return client.replyMessage(event.replyToken, buildPersonsMessage([], knownPersons));
}

// ── State: add_persons ────────────────────────────────────────────────────────

async function handleAddPersons(event, userId, session, text) {
  const bill = { ...session.data.bill };
  const knownPersons = [...(session.data.knownPersons || [])];

  if (text === '✓ เสร็จแล้ว' || text === 'เสร็จ') {
    await db.setSession(userId, 'confirm', { bill, knownPersons });
    return client.replyMessage(event.replyToken, buildConfirmMessage(bill));
  }

  if (text === 'ไม่หาร') {
    bill.persons = [];
    bill.personTotals = {};
    await db.setSession(userId, 'confirm', { bill, knownPersons });
    return client.replyMessage(event.replyToken, buildConfirmMessage(bill));
  }

  if (!text || bill.persons.includes(text)) {
    return client.replyMessage(event.replyToken, buildPersonsMessage(bill.persons, knownPersons));
  }

  bill.persons.push(text);
  if (!knownPersons.includes(text)) knownPersons.push(text);

  await db.setSession(userId, 'add_persons', { bill, knownPersons });
  return client.replyMessage(event.replyToken, buildPersonsMessage(bill.persons, knownPersons));
}

// ── State: confirm ────────────────────────────────────────────────────────────

async function handleConfirm(event, userId, session, text) {
  const bill = { ...session.data.bill };
  const knownPersons = session.data.knownPersons || [];

  if (text === '✏️ ชื่อร้าน') {
    await db.setSession(userId, 'set_store', { bill });
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `ชื่อร้านปัจจุบัน: ${bill.store}\n\nพิมพ์ชื่อร้านใหม่:`,
    });
  }
  if (text === '✏️ บัตร') {
    await db.setSession(userId, 'set_card', { bill });
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'เลือกบัตรใหม่:',
      quickReply: { items: [...Object.keys(CARDS).map(c => qr(c, c)), qr('ไม่ระบุ', 'ไม่ระบุ')] },
    });
  }
  if (text === '✏️ ผ่อน') {
    await db.setSession(userId, 'set_install', { bill });
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: 'เลือกจำนวนเดือนใหม่:',
      quickReply: {
        items: [qr('ไม่ผ่อน', '0'), qr('3 เดือน', '3'), qr('4 เดือน', '4'), qr('6 เดือน', '6'), qr('10 เดือน', '10')],
      },
    });
  }
  if (text === '✏️ คนหาร') {
    bill.persons = [];
    bill.personTotals = {};
    await db.setSession(userId, 'add_persons', { bill, knownPersons });
    return client.replyMessage(event.replyToken, buildPersonsMessage([], knownPersons));
  }

  if (text !== '✓ บันทึก') {
    await db.clearSession(userId);
    return client.replyMessage(event.replyToken, { type: 'text', text: 'ยกเลิกแล้ว' });
  }

  if (bill.persons.length > 0) {
    const perPerson = bill.grand / bill.persons.length;
    bill.personTotals = {};
    bill.persons.forEach(p => { bill.personTotals[p] = perPerson; });
  }

  const { bills } = await db.getUserData(userId);
  bills.push(bill);
  await db.saveUserData(userId, bills, knownPersons);
  await db.clearSession(userId);

  const due = bill.card && CARDS[bill.card] ? getBillDueDate(bill.card, bill.date) : null;
  const dueLine = due ? `\n💳 ครบกำหนด ${fmtDate2(due)} (อีก ${daysUntil(due)} วัน)` : '';

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: `บันทึกแล้ว ✓\n\n${bill.store} — ${fmt(bill.grand)}${dueLine}`,
  });
}

// ── Postback handler ──────────────────────────────────────────────────────────

async function handlePostback(event, userId) {
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');
  const billId = params.get('billId');

  if (action === 'paid' || action === 'unpaid') {
    const { bills, knownPersons } = await db.getUserData(userId);
    const bill = bills.find(b => b.id === billId);
    if (!bill) {
      return client.replyMessage(event.replyToken, { type: 'text', text: 'ไม่พบบิล' });
    }
    bill.paid = (action === 'paid');
    await db.saveUserData(userId, bills, knownPersons);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `${action === 'paid' ? '✓' : '↩'} ${bill.store || 'บิล'} — ${action === 'paid' ? 'จ่ายแล้ว' : 'ยังไม่ได้จ่าย'}`,
    });
  }
}

// ── Message builders ──────────────────────────────────────────────────────────

function buildPersonsMessage(selectedPersons, knownPersons) {
  const remaining = knownPersons.filter(p => !selectedPersons.includes(p));
  const selectedText = selectedPersons.length
    ? selectedPersons.map(p => `✓ ${p}`).join(', ')
    : '-';

  const qrItems = remaining.slice(0, 11).map(p => qr(p.slice(0, 20), p));
  qrItems.push(qr('✓ เสร็จแล้ว', '✓ เสร็จแล้ว'));
  if (!selectedPersons.length) qrItems.push(qr('ไม่หาร', 'ไม่หาร'));

  return {
    type: 'text',
    text: `หารกับใครบ้าง?\n\nเลือกแล้ว: ${selectedText}\n\n(พิมพ์ชื่อเพื่อเพิ่มคนใหม่)`,
    quickReply: { items: qrItems.slice(0, 13) },
  };
}

function buildConfirmMessage(bill) {
  const lines = [
    '📋 สรุปบิล',
    '─────────────',
    `🏪 ${bill.store || '(ไม่ระบุ)'}`,
    `💰 ${fmt(bill.grand)} บาท`,
    `📅 ${fmtDate(bill.date)}`,
  ];

  if (bill.card) {
    const due = CARDS[bill.card] ? getBillDueDate(bill.card, bill.date) : null;
    lines.push(`💳 ${bill.card}${due ? ` — ครบ ${fmtDate2(due)} (อีก ${daysUntil(due)} วัน)` : ''}`);
  }

  if (bill.installMonths > 0) {
    lines.push(`📆 ผ่อน ${bill.installMonths} เดือน (${fmt(bill.grand / bill.installMonths)}/เดือน)`);
  }

  if (bill.persons.length > 0) {
    const perPerson = bill.grand / bill.persons.length;
    lines.push('', '👥 หารบิล:');
    bill.persons.forEach(p => lines.push(`  • ${p}: ${fmt(perPerson)}`));
  }

  lines.push('─────────────', 'ยืนยันบันทึก?');

  return {
    type: 'text',
    text: lines.join('\n'),
    quickReply: {
      items: [
        qr('✓ บันทึก', '✓ บันทึก'),
        qr('✏️ ชื่อร้าน', '✏️ ชื่อร้าน'),
        qr('✏️ บัตร', '✏️ บัตร'),
        qr('✏️ ผ่อน', '✏️ ผ่อน'),
        qr('✏️ คนหาร', '✏️ คนหาร'),
        qr('✗ ยกเลิก', '✗ ยกเลิก'),
      ],
    },
  };
}

function buildBillListFlex(bills) {
  if (!bills.length) return { type: 'text', text: 'ไม่มีบิล' };

  const bubbles = bills.slice(0, 10).map(buildBillBubble);
  return {
    type: 'flex',
    altText: `บิล ${bills.length} รายการ`,
    contents: bubbles.length === 1
      ? bubbles[0]
      : { type: 'carousel', contents: bubbles },
  };
}

function buildBillBubble(bill) {
  const due = bill.card && CARDS[bill.card] ? getBillDueDate(bill.card, bill.date) : null;
  const days = daysUntil(due);
  const dueColor = days < 0 ? '#DC2626' : days <= 3 ? '#DC2626' : days <= 7 ? '#D97706' : '#059669';

  const bodyContents = [
    {
      type: 'text',
      text: bill.store || '(ไม่ระบุ)',
      weight: 'bold',
      size: 'sm',
      color: '#1A1714',
      wrap: true,
    },
    {
      type: 'text',
      text: fmt(bill.grand),
      size: 'xl',
      weight: 'bold',
      color: bill.paid ? '#059669' : '#E84A35',
      margin: 'xs',
    },
  ];

  const metaContents = [
    ...(bill.date ? [{ type: 'text', text: fmtDate(bill.date), size: 'xs', color: '#9E9892', flex: 1 }] : []),
    ...(bill.card ? [{ type: 'text', text: bill.card, size: 'xs', color: '#9E9892', align: 'end' }] : []),
  ];
  if (metaContents.length) {
    bodyContents.push({ type: 'box', layout: 'horizontal', margin: 'sm', contents: metaContents });
  }

  if (due && !bill.paid) {
    bodyContents.push({
      type: 'text',
      text: `ครบกำหนด ${fmtDate2(due)}  ${days < 0 ? `เลย ${-days} วัน` : `อีก ${days} วัน`}`,
      size: 'xs',
      color: dueColor,
      margin: 'sm',
    });
  }

  if (bill.persons?.length > 0 && bill.personTotals) {
    const lines = bill.persons.map(p => `${p}: ${fmt(bill.personTotals[p] || 0)}`).join('\n');
    bodyContents.push({ type: 'text', text: lines, size: 'xs', color: '#4B4640', margin: 'sm', wrap: true });
  }

  const paidLabel = bill.paid ? '↩ ยังไม่ได้จ่าย' : '✓ จ่ายแล้ว';
  const paidData = `action=${bill.paid ? 'unpaid' : 'paid'}&billId=${bill.id}`;

  return {
    type: 'bubble',
    size: 'kilo',
    styles: {
      body: { backgroundColor: bill.paid ? '#F0FDF4' : '#FFFFFF' },
      footer: { backgroundColor: bill.paid ? '#F0FDF4' : '#FFFFFF' },
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '14px',
      spacing: 'none',
      contents: bodyContents,
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '8px',
      contents: [{
        type: 'button',
        action: { type: 'postback', label: paidLabel, data: paidData },
        style: 'secondary',
        height: 'sm',
      }],
    },
  };
}

function buildStatsText(bills) {
  if (!bills.length) return 'ยังไม่มีบิล';

  const total = bills.reduce((s, b) => s + (b.grand || 0), 0);
  const unpaid = bills.filter(b => !b.paid);
  const unpaidTotal = unpaid.reduce((s, b) => s + (b.grand || 0), 0);

  const byCard = {};
  bills.forEach(b => {
    if (b.card) byCard[b.card] = (byCard[b.card] || 0) + (b.grand || 0);
  });

  const lines = [
    '📊 สรุปยอด',
    '─────────────',
    `รวมทั้งหมด: ${fmt(total)} (${bills.length} บิล)`,
    `ค้างจ่าย: ${fmt(unpaidTotal)} (${unpaid.length} บิล)`,
  ];

  if (Object.keys(byCard).length) {
    lines.push('', 'แยกตามบัตร:');
    Object.entries(byCard)
      .sort((a, b) => b[1] - a[1])
      .forEach(([card, amt]) => {
        const due = CARDS[card] ? getNextDueDate(card) : null;
        const daysLeft = due ? daysUntil(due) : null;
        const dueStr = due ? ` — ครบ ${fmtDate2(due)} (อีก ${daysLeft} วัน)` : '';
        lines.push(`• ${card}: ${fmt(amt)}${dueStr}`);
      });
  }

  return lines.join('\n');
}

// ── Claude OCR ────────────────────────────────────────────────────────────────

function detectMediaType(base64) {
  const bytes = Buffer.from(base64.slice(0, 12), 'base64');
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[4] === 0x57) return 'image/webp';
  return 'image/jpeg';
}

async function extractBillData(base64) {
  const mediaType = detectMediaType(base64);
  const msg = await anthropic.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: 'อ่านบิลนี้และตอบเป็น JSON เท่านั้น ไม่มีข้อความอื่น:\n{"store":null,"date":null,"items":[{"name":"","qty":1,"price":0}],"disc_pct":0,"sc_pct":0,"vat_pct":0,"total":0}\nถ้าวันที่เป็น พ.ศ. แปลงเป็น ค.ศ. (รูปแบบ YYYY-MM-DD) ถ้าข้อมูลใดไม่มีให้ใส่ null หรือ 0',
        },
      ],
    }],
  });

  const text = msg.content[0].text.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in Claude response');
  return JSON.parse(match[0]);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function qr(label, text) {
  return { type: 'action', action: { type: 'message', label, text } };
}

function fmt(n) {
  return '฿' + Number(n || 0).toLocaleString('th', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

function fmtDate2(date) {
  if (!date) return '';
  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
}

function randomId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getNextDueDate(cardName) {
  const c = CARDS[cardName];
  if (!c) return null;
  const now = new Date();
  let due = new Date(now.getFullYear(), now.getMonth(), c.due);
  if (due <= now) due = new Date(now.getFullYear(), now.getMonth() + 1, c.due);
  return due;
}

function getBillDueDate(cardName, billDateStr) {
  const c = CARDS[cardName];
  if (!c) return null;
  const ds = billDateStr || new Date().toISOString().split('T')[0];
  const [y, mo, d] = ds.split('-').map(Number);
  const m0 = mo - 1;
  if (c.cut == null) {
    return new Date(y, d <= c.due ? m0 : m0 + 1, c.due);
  }
  const cutM = d <= c.cut ? m0 : m0 + 1;
  const dueM = c.due <= c.cut ? cutM + 1 : cutM;
  return new Date(y, dueM, c.due);
}

function daysUntil(date) {
  if (!date) return Infinity;
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((date - startToday) / 86400000);
}

function fmtMoney(n) {
  const parts = Number(n || 0).toFixed(2).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '฿' + parts.join('.');
}

// ── Cron: due-date reminders ──────────────────────────────────────────────────

function formatReminderMessage(cardName, due, days, bills) {
  const total = bills.reduce((s, b) => s + (b.grand || 0), 0);
  const personSums = {};
  bills.forEach(b => {
    if (b.personTotals) {
      Object.entries(b.personTotals).forEach(([p, a]) => {
        personSums[p] = (personSums[p] || 0) + a;
      });
    }
  });
  const personLines = Object.entries(personSums).map(([p, a]) => `• ${p}: ${fmtMoney(a)}`).join('\n');
  const billLines = bills.map(b => `• ${b.store || 'บิล'}: ${fmtMoney(b.grand)}`).join('\n');
  const dueStr = `${due.getDate()}/${due.getMonth() + 1}/${due.getFullYear()}`;
  return [
    `🔔 ${cardName} ใกล้ครบกำหนดชำระ`,
    `ครบกำหนด ${dueStr} (อีก ${days} วัน)`,
    `ยอดรวม ${fmtMoney(total)}`,
    '',
    personLines || billLines,
  ].join('\n');
}

async function sendRemindersForUser(userId, bills) {
  const groups = {};
  (bills || []).forEach(b => {
    if (b.paid || !b.card || !CARDS[b.card]) return;
    const due = getBillDueDate(b.card, b.date);
    const days = daysUntil(due);
    if (!REMINDER_OFFSETS.includes(days)) return;
    const key = `${b.card}|${days}`;
    if (!groups[key]) groups[key] = { card: b.card, due, days, bills: [] };
    groups[key].bills.push(b);
  });
  const list = Object.values(groups);
  for (const g of list) {
    try {
      await client.pushMessage(userId, {
        type: 'text',
        text: formatReminderMessage(g.card, g.due, g.days, g.bills),
      });
    } catch (e) {
      console.error('push reminder failed', userId, g.card, e);
    }
  }
  return list.length;
}

async function runDueReminderSweep() {
  const rows = await db.getAllUserData();
  let remindersSent = 0;
  for (const row of rows) {
    try {
      remindersSent += await sendRemindersForUser(row.userId, row.bills);
    } catch (e) {
      console.error('reminder sweep failed for user', row.userId, e);
    }
  }
  return { usersChecked: rows.length, remindersSent };
}

app.use(express.json());

app.get('/api/cron/notify-due', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await runDueReminderSweep();
    console.log('due reminder sweep', result);
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('reminder sweep endpoint failed', e);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/admin/import', async (req, res) => {
  if (!process.env.CRON_SECRET || req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { userId, bills } = req.body;
  if (!userId || !Array.isArray(bills)) {
    return res.status(400).json({ error: 'need userId and bills[]' });
  }
  try {
    const existing = await db.getUserData(userId);
    const merged = [...(existing.bills || [])];
    const existingIds = new Set(merged.map(b => String(b.id)));
    let added = 0;
    for (const b of bills) {
      if (!existingIds.has(String(b.id))) {
        merged.push(b);
        added++;
      }
    }
    const persons = [...new Set(merged.flatMap(b => b.persons || []))];
    await db.saveUserData(userId, merged, persons);
    res.json({ ok: true, added, total: merged.length });
  } catch (e) {
    console.error('import failed', e);
    res.status(500).json({ error: String(e.message) });
  }
});

const PORT = process.env.PORT || 3000;

db.ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`Bill Tracker bot listening on :${PORT}`));
  })
  .catch(err => {
    console.error('Failed to initialize database schema', err);
    process.exit(1);
  });
