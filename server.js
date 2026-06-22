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

  if (['myid', 'my id', 'userid', 'user id'].includes(text.toLowerCase())) {
    return client.replyMessage(event.replyToken, { type: 'text', text: `User ID:\n${userId}` });
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
    return client.replyMessage(event.replyToken, buildBillListFlex(sortByDate(unpaid).slice(0, 10)));
  }

  if (lower === 'ดูทั้งหมด' || lower === 'all') {
    const { bills } = await db.getUserData(userId);
    if (!bills.length) return client.replyMessage(event.replyToken, { type: 'text', text: 'ยังไม่มีบิล' });
    return client.replyMessage(event.replyToken, buildBillListFlex(sortByDate(bills).slice(0, 10)));
  }

  if (lower === 'สรุป' || lower === 'summary') {
    const { bills } = await db.getUserData(userId);
    return client.replyMessage(event.replyToken, buildStatsFlex(bills));
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

  if (action === 'delete_confirm') {
    const { bills } = await db.getUserData(userId);
    const bill = bills.find(b => String(b.id) === String(billId));
    if (!bill) {
      return client.replyMessage(event.replyToken, { type: 'text', text: 'ไม่พบบิล' });
    }
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `ลบ "${bill.store || 'บิล'}" (${fmt(bill.grand)}) ใช่ไหม?`,
      quickReply: {
        items: [
          { type: 'action', action: { type: 'postback', label: '✓ ลบเลย', data: `action=delete&billId=${bill.id}` } },
          qr('✗ ยกเลิก', '✗ ยกเลิก'),
        ],
      },
    });
  }

  if (action === 'filter_card') {
    const card = params.get('card');
    const { bills } = await db.getUserData(userId);
    const filtered = sortByDate(bills.filter(b => b.card === card && !b.paid));
    if (!filtered.length) return client.replyMessage(event.replyToken, { type: 'text', text: `ไม่มีบิลค้างจ่าย ${card}` });
    return client.replyMessage(event.replyToken, buildBillListFlex(filtered.slice(0, 10)));
  }

  if (action === 'filter_person') {
    const person = decodeURIComponent(params.get('person') || '');
    const { bills } = await db.getUserData(userId);
    const filtered = sortByDate(bills.filter(b => !b.paid && b.persons?.includes(person)));
    if (!filtered.length) return client.replyMessage(event.replyToken, { type: 'text', text: `ไม่มีบิลค้างจ่าย ${person}` });
    return client.replyMessage(event.replyToken, buildBillListFlex(filtered.slice(0, 10)));
  }

  if (action === 'pay_month') {
    const month = parseInt(params.get('month'));
    const { bills, knownPersons } = await db.getUserData(userId);
    const bill = bills.find(b => String(b.id) === String(billId));
    if (!bill) return client.replyMessage(event.replyToken, { type: 'text', text: 'ไม่พบบิล' });
    if (!bill.paidMonths) bill.paidMonths = [];
    if (!bill.paidMonths.includes(month)) bill.paidMonths.push(month);
    bill.paidMonths.sort((a, b) => a - b);
    if (bill.paidMonths.length >= bill.installMonths) bill.paid = true;
    await db.saveUserData(userId, bills, knownPersons);
    const paidCount = bill.paidMonths.length;
    const done = paidCount >= bill.installMonths;
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: done
        ? `✓ ${bill.store} — ผ่อนครบ ${bill.installMonths} เดือนแล้ว!`
        : `✓ บันทึกเดือน ${month} แล้ว (${paidCount}/${bill.installMonths} เดือน)\nเหลืออีก ${bill.installMonths - paidCount} เดือน`,
    });
  }

  if (action === 'delete') {
    const { bills, knownPersons } = await db.getUserData(userId);
    const idx = bills.findIndex(b => String(b.id) === String(billId));
    if (idx === -1) {
      return client.replyMessage(event.replyToken, { type: 'text', text: 'ไม่พบบิล' });
    }
    const removed = bills.splice(idx, 1)[0];
    await db.saveUserData(userId, bills, knownPersons);
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: `🗑️ ลบแล้ว: ${removed.store || 'บิล'} — ${fmt(removed.grand)}`,
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

function sortByDate(bills) {
  return [...bills].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
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
  const isOverdue = days < 0;
  const isDueSoon = !isOverdue && days <= 3;

  const headerBg = bill.paid ? '#059669' : isOverdue ? '#DC2626' : isDueSoon ? '#D97706' : '#374151';
  const headerText = bill.paid ? '✓ จ่ายแล้ว' : isOverdue ? `⚠️ เลยกำหนด ${-days} วัน` : isDueSoon ? `🔔 อีก ${days} วัน` : '📋 ค้างจ่าย';

  const bodyContents = [
    { type: 'text', text: bill.store || '(ไม่ระบุ)', weight: 'bold', size: 'sm', color: '#1A1714', wrap: true, maxLines: 2 },
    { type: 'text', text: fmt(bill.grand), size: 'xxl', weight: 'bold', color: bill.paid ? '#059669' : '#E84A35', margin: 'xs' },
  ];

  const metaContents = [
    ...(bill.date ? [{ type: 'text', text: fmtDate(bill.date), size: 'xs', color: '#9E9892', flex: 1 }] : []),
    ...(bill.card ? [{ type: 'text', text: bill.card, size: 'xs', color: '#6366F1', align: 'end', weight: 'bold' }] : []),
  ];
  if (metaContents.length) bodyContents.push({ type: 'box', layout: 'horizontal', margin: 'sm', contents: metaContents });

  if (bill.installMonths > 0) {
    const paidMonths = bill.paidMonths || [];
    const paidCount = paidMonths.length;
    bodyContents.push({ type: 'text', text: `📆 ผ่อน ${paidCount}/${bill.installMonths} เดือน · ${fmt(bill.grand / bill.installMonths)}/เดือน`, size: 'xs', color: '#6366F1', margin: 'xs' });
    const monthStr = Array.from({ length: bill.installMonths }, (_, i) => {
      const m = i + 1;
      return paidMonths.includes(m) ? `ม.${m}✓` : `ม.${m}`;
    }).join('  ');
    bodyContents.push({ type: 'text', text: monthStr, size: 'xs', color: '#4B4640', margin: 'xs', wrap: true });
  }

  if (due && !bill.paid) {
    const dueColor = isOverdue ? '#DC2626' : isDueSoon ? '#D97706' : '#6B7280';
    bodyContents.push({ type: 'text', text: `📅 ครบกำหนด ${fmtDate2(due)}`, size: 'xs', color: dueColor, margin: 'sm' });
  }

  if (bill.persons?.length > 0 && bill.personTotals) {
    const lines = bill.persons.map(p => `${p} ${fmt(bill.personTotals[p] || 0)}`).join('  ');
    bodyContents.push({ type: 'text', text: `👥 ${lines}`, size: 'xs', color: '#4B4640', margin: 'sm', wrap: true });
  }

  // Footer buttons — installment vs regular
  let footerButtons;
  if (bill.installMonths > 0 && !bill.paid) {
    const paidMonths = bill.paidMonths || [];
    const nextMonth = Array.from({ length: bill.installMonths }, (_, i) => i + 1).find(m => !paidMonths.includes(m));
    footerButtons = nextMonth
      ? [
          { type: 'button', action: { type: 'postback', label: `✓ จ่ายเดือน ${nextMonth}`, data: `action=pay_month&billId=${bill.id}&month=${nextMonth}` }, style: 'primary', height: 'sm', flex: 3, color: '#6366F1' },
          { type: 'button', action: { type: 'postback', label: '🗑️', data: `action=delete_confirm&billId=${bill.id}` }, style: 'secondary', height: 'sm', flex: 1, color: '#DC2626' },
        ]
      : [
          { type: 'button', action: { type: 'postback', label: '✓ ผ่อนครบแล้ว', data: `action=paid&billId=${bill.id}` }, style: 'primary', height: 'sm', flex: 3, color: '#059669' },
          { type: 'button', action: { type: 'postback', label: '🗑️', data: `action=delete_confirm&billId=${bill.id}` }, style: 'secondary', height: 'sm', flex: 1, color: '#DC2626' },
        ];
  } else {
    const paidLabel = bill.paid ? '↩ ยังไม่ได้จ่าย' : '✓ จ่ายแล้ว';
    const paidData = `action=${bill.paid ? 'unpaid' : 'paid'}&billId=${bill.id}`;
    footerButtons = [
      { type: 'button', action: { type: 'postback', label: paidLabel, data: paidData }, style: 'secondary', height: 'sm', flex: 3 },
      { type: 'button', action: { type: 'postback', label: '🗑️ ลบ', data: `action=delete_confirm&billId=${bill.id}` }, style: 'secondary', height: 'sm', flex: 1, color: '#DC2626' },
    ];
  }

  return {
    type: 'bubble',
    size: 'kilo',
    header: {
      type: 'box',
      layout: 'baseline',
      backgroundColor: headerBg,
      paddingAll: '8px',
      contents: [{ type: 'text', text: headerText, color: '#FFFFFF', size: 'xs', weight: 'bold' }],
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
      layout: 'horizontal',
      paddingAll: '8px',
      spacing: 'sm',
      contents: footerButtons,
    },
  };
}

function buildStatsFlex(bills) {
  if (!bills.length) return { type: 'text', text: 'ยังไม่มีบิล' };

  const total = bills.reduce((s, b) => s + (b.grand || 0), 0);
  const unpaid = bills.filter(b => !b.paid);
  const unpaidTotal = unpaid.reduce((s, b) => s + (b.grand || 0), 0);

  const row = (label, value, labelColor = '#6B7280', valueColor = '#1A1714') => ({
    type: 'box', layout: 'horizontal', margin: 'xs',
    contents: [
      { type: 'text', text: label, size: 'sm', color: labelColor, flex: 3 },
      { type: 'text', text: value, size: 'sm', weight: 'bold', color: valueColor, align: 'end', flex: 2 },
    ],
  });

  const bodyContents = [
    { type: 'text', text: '📊 สรุปยอด', weight: 'bold', size: 'md', color: '#1A1714' },
    { type: 'separator', margin: 'sm' },
    row('รวมทั้งหมด', fmt(total)),
    row(`ค้างจ่าย (${unpaid.length} บิล)`, fmt(unpaidTotal), '#DC2626', '#DC2626'),
  ];

  const byCard = {};
  const byCardPersons = {};
  unpaid.forEach(b => {
    if (!b.card) return;
    byCard[b.card] = (byCard[b.card] || 0) + (b.grand || 0);
    if (!byCardPersons[b.card]) byCardPersons[b.card] = {};
    if (b.personTotals) {
      Object.entries(b.personTotals).forEach(([p, a]) => {
        byCardPersons[b.card][p] = (byCardPersons[b.card][p] || 0) + (a || 0);
      });
    }
  });
  if (Object.keys(byCard).length) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: '💳 แยกตามบัตร  (แตะเพื่อดูบิล)', size: 'xs', color: '#6B7280', margin: 'md', weight: 'bold' });
    Object.entries(byCard).sort((a, b) => b[1] - a[1]).forEach(([card, amt]) => {
      const due = CARDS[card] ? getNextDueDate(card) : null;
      const days = due ? daysUntil(due) : null;
      const dueColor = days !== null ? (days <= 3 ? '#DC2626' : days <= 7 ? '#D97706' : '#059669') : '#9E9892';
      const dueText = due ? `ครบ ${fmtDate2(due)}` : '';
      bodyContents.push({
        type: 'box', layout: 'horizontal', margin: 'sm',
        action: { type: 'postback', label: card, data: `action=filter_card&card=${card}` },
        contents: [
          { type: 'text', text: card, size: 'sm', color: '#6366F1', flex: 2, weight: 'bold' },
          { type: 'text', text: fmt(amt), size: 'sm', weight: 'bold', color: '#1A1714', align: 'end', flex: 2 },
          { type: 'text', text: dueText, size: 'xs', color: dueColor, align: 'end', flex: 2 },
        ],
      });
      const cardPersons = byCardPersons[card] || {};
      Object.entries(cardPersons).sort((a, b) => b[1] - a[1]).forEach(([p, a]) => {
        bodyContents.push({
          type: 'box', layout: 'horizontal', margin: 'xs', paddingStart: '12px',
          contents: [
            { type: 'text', text: `· ${p}`, size: 'xs', color: '#6B7280', flex: 3 },
            { type: 'text', text: fmt(a), size: 'xs', color: '#4B4640', align: 'end', flex: 2 },
          ],
        });
      });
    });
  }

  const byPerson = {};
  unpaid.forEach(b => { if (b.personTotals) Object.entries(b.personTotals).forEach(([p, a]) => { byPerson[p] = (byPerson[p] || 0) + (a || 0); }); });
  if (Object.keys(byPerson).length) {
    bodyContents.push({ type: 'separator', margin: 'md' });
    bodyContents.push({ type: 'text', text: '👥 แยกตามคน  (แตะเพื่อดูบิล)', size: 'xs', color: '#6B7280', margin: 'md', weight: 'bold' });
    Object.entries(byPerson).sort((a, b) => b[1] - a[1]).forEach(([p, amt]) => {
      bodyContents.push({
        type: 'box', layout: 'horizontal', margin: 'xs',
        action: { type: 'postback', label: p, data: `action=filter_person&person=${encodeURIComponent(p)}` },
        contents: [
          { type: 'text', text: p, size: 'sm', color: '#059669', flex: 3, weight: 'bold' },
          { type: 'text', text: fmt(amt), size: 'sm', weight: 'bold', color: '#1A1714', align: 'end', flex: 2 },
        ],
      });
    });
  }

  return {
    type: 'flex',
    altText: `สรุปยอด ${fmt(total)} / ค้างจ่าย ${fmt(unpaidTotal)}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      body: { type: 'box', layout: 'vertical', paddingAll: '16px', contents: bodyContents },
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

  const byPerson = {};
  bills.forEach(b => {
    if (b.personTotals && Object.keys(b.personTotals).length) {
      Object.entries(b.personTotals).forEach(([p, a]) => {
        byPerson[p] = (byPerson[p] || 0) + (a || 0);
      });
    }
  });
  if (Object.keys(byPerson).length) {
    lines.push('', 'แยกตามคน:');
    Object.entries(byPerson)
      .sort((a, b) => b[1] - a[1])
      .forEach(([p, amt]) => lines.push(`• ${p}: ${fmt(amt)}`));
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

app.get('/api/run-import-3f8a2b', async (req, res) => {
  const TARGET_USER = 'U11a8f311007442eff3528b06a48b78ad';
  const BILLS = [{"store":"Star fashion","date":"2026-05-08","card":"KBank Plat","note":"","installMonths":0,"items":[{"name":"Stanley","qty":1,"price":1195}],"disc":0,"sc":0,"vat":0,"scAmt":0,"vatAmt":0,"sub":1195,"grand":1195,"personTotals":{"Papa":1195},"persons":["Papa"],"id":1781583935078,"img":null,"paid":false,"paidMonths":[]},{"store":"Kinokuniya","date":"2026-05-10","card":"","note":"","installMonths":0,"items":[{"name":"Moomin","qty":1,"price":446},{"name":"Jill","qty":1,"price":449},{"name":"Coleman","qty":1,"price":570},{"name":"Coleman","qty":1,"price":446}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":1911,"grand":1911,"personTotals":{"Jn":1016,"May":449,"Mama":446},"persons":["Jn","May","Mama"],"id":1781604138601,"img":null,"paid":false,"paidMonths":[]},{"store":"Foodland","date":"2026-05-15","card":"","note":"","installMonths":0,"items":[{"name":"Magiclean","qty":1,"price":90},{"name":"Babi mild","qty":1,"price":95},{"name":"น้ำยาซัก","qty":1,"price":358},{"name":"ผอนม","qty":1,"price":49},{"name":"ทิชชู่เปียก","qty":1,"price":99},{"name":"ฟลอย","qty":1,"price":79},{"name":"ถั่ว","qty":1,"price":36.25},{"name":"ใบกระเพรา","qty":1,"price":12},{"name":"นม","qty":1,"price":22.25},{"name":"กระดาษซับ","qty":2,"price":59}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":958.5,"grand":958.5,"personTotals":{"Jn":504.25,"May":454.25},"persons":["Jn","May"],"id":1781604634982,"img":null,"paid":false,"paidMonths":[]},{"store":"Luxe gallery","date":"2026-05-16","card":"","note":"","installMonths":0,"items":[{"name":"Tee","qty":2,"price":1049}],"disc":20,"sc":0,"vat":0,"discAmt":419.6,"scAmt":0,"vatAmt":0,"sub":2098,"grand":1678.4,"personTotals":{"Papa":1678.4},"persons":["Papa"],"id":1781604750299,"img":null,"paid":false,"paidMonths":[]},{"store":"Luxe gallery","date":"2026-05-15","card":"","note":"","installMonths":3,"items":[{"name":"Vivien","qty":1,"price":4765.2},{"name":"Vivien","qty":1,"price":3565.2}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":8330.4,"grand":8330.4,"personTotals":{"Jn":4765.2,"May":3565.2},"persons":["Jn","May"],"id":1781605083304,"img":null,"paid":false,"paidMonths":[]},{"store":"Siam takashimaya","date":"2026-05-17","card":"UOB","note":"","installMonths":0,"items":[{"name":"Snow peak","qty":1,"price":760},{"name":"Snow peak","qty":1,"price":1440}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":2200,"grand":2200,"personTotals":{"Jn":1440,"May":760},"persons":["Jn","May"],"id":1781605212006,"img":null,"paid":false,"paidMonths":[]},{"store":"Go wholesale","date":"2026-05-29","card":"the1","note":"","installMonths":0,"items":[{"name":"Tofu mushroom","qty":1,"price":47},{"name":"Chilli","qty":1,"price":25},{"name":"เต๋าเต้ย","qty":1,"price":451.5},{"name":"กระพง","qty":1,"price":244.25},{"name":"กระพง","qty":1,"price":261.25},{"name":"มะม่วง","qty":1,"price":86.5},{"name":"มังคุด","qty":1,"price":53.25}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":1168.75,"grand":1168.75,"personTotals":{"Jn":389.58,"May":389.58,"Mama":389.58},"persons":["Jn","May","Mama"],"id":1781605836656,"img":null,"paid":false,"paidMonths":[]},{"store":"Uniqlo","date":"2026-05-31","card":"UOB","note":"","installMonths":0,"items":[{"name":"Denim short","qty":1,"price":590}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":590,"grand":590,"personTotals":{"Mama":590},"persons":["Mama"],"id":1781605876914,"img":null,"paid":false,"paidMonths":[]},{"store":"Makro","date":"2026-06-01","card":"UOB","note":"","installMonths":0,"items":[{"name":"อกไก่","qty":1,"price":130},{"name":"หมู","qty":1,"price":80},{"name":"สันใน","qty":1,"price":138},{"name":"มังคุด","qty":1,"price":69},{"name":"ไก่อบ","qty":1,"price":119}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":536,"grand":536,"personTotals":{"May":128.5,"Jn":407.5},"persons":["May","Jn"],"id":1781605968956,"img":null,"paid":false,"paidMonths":[]},{"store":"True","date":"2026-06-04","card":"KBank Plat","note":"","installMonths":0,"items":[{"name":"True","qty":1,"price":1638.17}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":1638.17,"grand":1638.17,"personTotals":{"Mama":1638.17},"persons":["Mama"],"id":1781606079836,"img":null,"paid":false,"paidMonths":[]},{"store":"Hotpot man","date":"2026-06-05","card":"UOB","note":"","installMonths":0,"items":[{"name":"Buf jn","qty":2,"price":299},{"name":"Buf na","qty":1,"price":299},{"name":"Buf air","qty":2,"price":299}],"disc":0,"sc":0,"vat":7,"discAmt":0,"scAmt":0,"vatAmt":104.65,"sub":1495,"grand":1599.65,"personTotals":{"Jn":639.86,"Air":639.86,"Noina":319.93},"persons":["Jn","Air","Noina"],"id":1781606282872,"img":null,"paid":false,"paidMonths":[]},{"store":"Levi's","date":"2026-06-06","card":"UOB","note":"","installMonths":0,"items":[{"name":"Pant","qty":1,"price":2860},{"name":"Pant","qty":1,"price":2920}],"disc":50,"sc":0,"vat":0,"discAmt":2890,"scAmt":0,"vatAmt":0,"sub":5780,"grand":2890,"personTotals":{"Jn":1430,"Mama":1460},"persons":["Jn","Mama"],"id":1781606368803,"img":null,"paid":false,"paidMonths":[]},{"store":"Levis","date":"2026-06-06","card":"UOB","note":"","installMonths":0,"items":[{"name":"Short","qty":1,"price":1920},{"name":"Cardigan","qty":1,"price":1860}],"disc":50,"sc":0,"vat":0,"discAmt":1890,"scAmt":0,"vatAmt":0,"sub":3780,"grand":1890,"personTotals":{"May":930,"Papa":960},"persons":["May","Papa"],"id":1781606421004,"img":null,"paid":false,"paidMonths":[]},{"store":"True","date":"2026-06-07","card":"KBank Plat","note":"","installMonths":0,"items":[{"name":"True bill","qty":1,"price":2136.42}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":2136.42,"grand":2136.42,"personTotals":{"Jn":2136.42},"persons":["Jn"],"id":1781606459095,"img":null,"paid":false,"paidMonths":[]},{"store":"Levi's","date":"2026-06-07","card":"FC","note":"","installMonths":3,"items":[{"name":"Pant","qty":1,"price":7990}],"disc":0,"sc":0,"vat":2.1,"discAmt":0,"scAmt":0,"vatAmt":167.79,"sub":7990,"grand":8157.79,"personTotals":{"Jn":4078.90,"May":4078.90},"persons":["Jn","May"],"id":1781606577243,"img":null,"paid":false,"paidMonths":[]},{"store":"Levi's","date":"2026-06-07","card":"FC","note":"","installMonths":0,"items":[{"name":"Pant","qty":1,"price":7990}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":7990,"grand":7990,"personTotals":{"Mama":7990},"persons":["Mama"],"id":1781606597395,"img":null,"paid":false,"paidMonths":[]},{"store":"Noodle","date":"2026-06-07","card":"UOB","note":"","installMonths":0,"items":[{"name":"ตรอกมะระกา","qty":1,"price":965.75}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":965.75,"grand":965.75,"personTotals":{"Jn":241.44,"May":241.44,"Mama":241.44,"Papa":241.44},"persons":["Jn","May","Mama","Papa"],"id":1781606727987,"img":null,"paid":false,"paidMonths":[]},{"store":"Tops","date":"2026-06-07","card":"the1","note":"","installMonths":0,"items":[{"name":"Tops","qty":1,"price":366}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":366,"grand":366,"personTotals":{"Jn":366},"persons":["Jn"],"id":1781606760626,"img":null,"paid":false,"paidMonths":[]},{"store":"Laderach","date":"2026-06-10","card":"UOB","note":"","installMonths":0,"items":[{"name":"Chocolate","qty":1,"price":992.8}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":992.8,"grand":992.8,"personTotals":{"Jn":992.8},"persons":["Jn"],"id":1781606839008,"img":null,"paid":false,"paidMonths":[]},{"store":"Adidas","date":"2026-06-07","card":"UOB","note":"","installMonths":0,"items":[{"name":"Pant","qty":1,"price":799}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":799,"grand":799,"personTotals":{"Jn":799},"persons":["Jn"],"id":1781606852777,"img":null,"paid":false,"paidMonths":[]},{"store":"Laderach","date":"2026-06-11","card":"UOB","note":"","installMonths":0,"items":[{"name":"Chocolate","qty":1,"price":558.6},{"name":"Chocolate","qty":1,"price":90}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":648.6,"grand":648.6,"personTotals":{"Mama":558.6,"Omtawan":90},"persons":["Mama","Omtawan"],"id":1781606903965,"img":null,"paid":false,"paidMonths":[]},{"store":"Fuji","date":"2026-06-12","card":"UOB","note":"","installMonths":0,"items":[{"name":"Bento sakura","qty":1,"price":210},{"name":"Bento","qty":1,"price":530},{"name":"Fish","qty":1,"price":300},{"name":"Salad","qty":1,"price":160},{"name":"Water","qty":1,"price":20}],"disc":7.5,"sc":10,"vat":0,"discAmt":91.5,"scAmt":112.85,"vatAmt":0,"sub":1220,"grand":1241.35,"personTotals":{"Jn":315.42,"May":259.46,"Mama":315.42,"Papa":351.04},"persons":["Jn","May","Mama","Papa"],"id":1781607069880,"img":null,"paid":false,"paidMonths":[]},{"store":"Jaspal","date":"2026-06-12","card":"UOB","note":"","installMonths":0,"items":[{"name":"Jeans","qty":1,"price":1147.5}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":1147.5,"grand":1147.5,"personTotals":{"Jn":1147.5},"persons":["Jn"],"id":1781607095669,"img":null,"paid":false,"paidMonths":[]},{"store":"Levi's","date":"2026-06-13","card":"FC","note":"","installMonths":3,"items":[{"name":"Jeans","qty":3,"price":890}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":2670,"grand":2670,"personTotals":{"Jn":2670},"persons":["Jn"],"id":1781607142729,"img":null,"paid":false,"paidMonths":[]},{"store":"Luxe gallery","date":"2026-06-13","card":"FC","note":"","installMonths":3,"items":[{"name":"Tee","qty":2,"price":1769}],"disc":20,"sc":0,"vat":0,"discAmt":707.6,"scAmt":0,"vatAmt":0,"sub":3538,"grand":2830.4,"personTotals":{"Jn":2830.4},"persons":["Jn"],"id":1781607178919,"img":null,"paid":false,"paidMonths":[]},{"store":"Go (grab)","date":"2026-06-14","card":"Line","note":"","installMonths":0,"items":[{"name":"Tofu","qty":1,"price":94},{"name":"ไลปอนเอฟ","qty":1,"price":78},{"name":"กล้วย","qty":1,"price":32},{"name":"นม","qty":1,"price":160},{"name":"เต้าหุ้","qty":1,"price":37}],"disc":30,"sc":0,"vat":0,"discAmt":120.3,"scAmt":0,"vatAmt":0,"sub":401,"grand":280.7,"personTotals":{"Jn":189,"Mama":91.7},"persons":["Jn","Mama"],"id":1781607465496,"img":null,"paid":false,"paidMonths":[]},{"store":"Noodle (grab)","date":"2026-06-14","card":"Line","note":"","installMonths":0,"items":[{"name":"Udon","qty":1,"price":75},{"name":"Pork","qty":1,"price":105},{"name":"Noodle","qty":3,"price":60}],"disc":4.5,"sc":0,"vat":0,"discAmt":16.2,"scAmt":0,"vatAmt":0,"sub":360,"grand":343.8,"personTotals":{"Jn":96.69,"May":82.37,"Mama":82.37,"Papa":82.37},"persons":["Jn","May","Mama","Papa"],"id":1781607610350,"img":null,"paid":false,"paidMonths":[]},{"store":"Anri bakery (grab)","date":"2026-06-14","card":"Line","note":"","installMonths":0,"items":[{"name":"Pie","qty":1,"price":259}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":259,"grand":259,"personTotals":{"Jn":129.5,"May":129.5},"persons":["Jn","May"],"id":1781607681780,"img":null,"paid":false,"paidMonths":[]},{"store":"Baker bricks (grab)","date":"2026-06-14","card":"Line","note":"","installMonths":0,"items":[{"name":"Scone","qty":1,"price":140}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":140,"grand":140,"personTotals":{"Jn":140},"persons":["Jn"],"id":1781607711032,"img":null,"paid":false,"paidMonths":[]},{"store":"Katsu midori","date":"2026-06-14","card":"the1","note":"","installMonths":0,"items":[{"name":"Sushi","qty":1,"price":1573}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":1573,"grand":1573,"personTotals":{"Jn":393.25,"May":393.25,"Mama":393.25,"Papa":393.25},"persons":["Jn","May","Mama","Papa"],"id":1781607755133,"img":null,"paid":false,"paidMonths":[]},{"store":"Jumping rope mat (Shopee)","date":"2026-06-15","card":"ShopeePay","note":"","installMonths":0,"items":[{"name":"Jumping rope mat","qty":1,"price":177}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":177,"grand":177,"personTotals":{"Jn":177},"persons":["Jn"],"id":1781607852133,"img":null,"paid":false,"paidMonths":[]},{"store":"Dr.pong (shopee)","date":"2026-06-15","card":"ShopeePay","note":"","installMonths":3,"items":[{"name":"Supplement","qty":1,"price":1834}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":1834,"grand":1834,"personTotals":{"Jn":1834},"persons":["Jn"],"id":1781607895792,"img":null,"paid":false,"paidMonths":[]},{"store":"Shampoo (shopee)","date":"2026-06-16","card":"KBank Plat","note":"","installMonths":0,"items":[{"name":"Shampoo","qty":1,"price":327}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":327,"grand":327,"personTotals":{"Jn":327},"persons":["Jn"],"id":1781607982123,"img":null,"paid":false,"paidMonths":[]},{"store":"Sourdough (shopee)","date":"2026-06-15","card":"KBank Plat","note":"","installMonths":0,"items":[{"name":"Sourdough","qty":1,"price":218}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":218,"grand":218,"personTotals":{"Jn":218},"persons":["Jn"],"id":1781608025248,"img":null,"paid":false,"paidMonths":[]},{"store":"Adidas rope (shopee)","date":"2026-06-15","card":"FC","note":"","installMonths":3,"items":[{"name":"Jumping rope","qty":1,"price":1188.56}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":1188.56,"grand":1188.56,"personTotals":{"Jn":1188.56},"persons":["Jn"],"id":1781608063881,"img":null,"paid":false,"paidMonths":[]},{"store":"Swensens","date":"2026-06-13","card":"UOB","note":"","installMonths":0,"items":[{"name":"Ice cream","qty":1,"price":307}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":307,"grand":307,"personTotals":{"Jn":153.5,"May":153.5},"persons":["Jn","May"],"id":1781608161420,"img":null,"paid":false,"paidMonths":[]},{"store":"Dettol (shopee)","date":"2026-06-17","card":"ShopeePay","note":"","installMonths":0,"items":[{"name":"Dettol ล้างเครื่องซักผ้า","qty":1,"price":299}],"disc":0,"sc":0,"vat":0,"discAmt":0,"scAmt":0,"vatAmt":0,"sub":299,"grand":299,"personTotals":{"Jn":149.5,"Mama":149.5},"persons":["Jn","Mama"],"id":1781684445633,"img":null,"paid":false,"paidMonths":[]}];
  try {
    const existing = await db.getUserData(TARGET_USER);
    const merged = [...(existing.bills || [])];
    const existingIds = new Set(merged.map(b => String(b.id)));
    let added = 0;
    for (const b of BILLS) {
      if (!existingIds.has(String(b.id))) { merged.push(b); added++; }
    }
    const persons = [...new Set(merged.flatMap(b => b.persons || []))];
    await db.saveUserData(TARGET_USER, merged, persons);
    res.json({ ok: true, added, total: merged.length });
  } catch (e) {
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
