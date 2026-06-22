# Bill Tracker — เวอร์ชัน LINE Official Account

ระบบเดิม (เว็บแอปไฟล์เดียว เก็บข้อมูลใน localStorage) ถูกแทนที่ด้วยระบบนี้ทั้งหมด ตามที่เลือกไว้ ("แทนที่เว็บแอปทั้งหมด") โครงสร้างใหม่:

- **LINE Official Account** — ส่งรูปบิลเข้าไปในแชทได้เลย บอทจะรับรูป เก็บไว้ และตอบกลับเป็นปุ่มให้กดตรวจสอบ
- **LIFF (LINE Front-end Framework)** — หน้าแอปเดิมทั้งหมด (เพิ่ม/แก้บิล, OCR, สรุปยอด, หารบิล) ยังอยู่ครบ แค่เปิดจากในแชท LINE แทนเว็บเบราว์เซอร์ และข้อมูลย้ายจาก localStorage มาเก็บที่เซิร์ฟเวอร์กลาง (ใช้ได้หลายเครื่อง/หลายคน แยกตามแอคเคาท์ LINE ของแต่ละคน)
- **เซิร์ฟเวอร์ (Node.js + Express)** — รับ webhook จาก LINE, เก็บรูปที่รอตรวจสอบ, มี API ให้หน้า LIFF อ่าน/เขียนข้อมูลบิล
- **ฐานข้อมูล (PostgreSQL)** — เก็บบิลและรายชื่อคนของแต่ละผู้ใช้ LINE แทน localStorage เดิม

OCR (อ่านบิลด้วย Tesseract.js) ยังทำงานแบบเดิมทุกอย่าง — รันในหน้า LIFF ตอนเปิดดูรูป ไม่ได้ย้ายไปเซิร์ฟเวอร์ เพื่อไม่ต้องแก้ลอจิกอ่านบิลที่ใช้อยู่แล้ว

ไฟล์ในโฟลเดอร์นี้ (`server.js`, `db.js`, `public/index.html`, ฯลฯ) **เสร็จและพร้อม deploy แล้ว** — ส่วนที่เหลือคือขั้นตอนที่ต้องทำเอง เพราะต้องใช้บัญชีส่วนตัว (LINE, Render) ซึ่งสร้างแทนกันไม่ได้

---

## สิ่งที่ต้องทำเอง (ทำตามลำดับ)

### 1. สร้าง LINE Messaging API channel

1. เข้า [LINE Developers Console](https://developers.line.biz/console/) ด้วยบัญชี LINE ของคุณ
2. สร้าง Provider (ถ้ายังไม่มี) → สร้าง Channel ใหม่ ชนิด **Messaging API**
3. ตั้งชื่อ เช่น "Bill Tracker"
4. ในแท็บ **Messaging API** ของ channel:
   - กด Issue เพื่อสร้าง **Channel access token (long-lived)** → คัดลอกไว้ → นี่คือ `LINE_CHANNEL_ACCESS_TOKEN`
   - คัดลอก **Channel secret** จากแท็บ **Basic settings** → นี่คือ `LINE_CHANNEL_SECRET`
   - ปิด "Auto-reply messages" และ "Greeting messages" (ของ LINE Official Account Manager) เพื่อไม่ให้ชนกับบอท
   - เปิด **Use webhook** เป็น ON (ค่า Webhook URL จะตั้งทีหลัง หลัง deploy เสร็จ — ข้ามไปก่อนได้)

### 2. สร้าง LIFF app ใน LINE Login channel แยกต่างหาก

LINE เลิกให้สร้าง LIFF app ภายใน Messaging API channel ตั้งแต่ปี 2020 (จะเห็นข้อความเตือนถ้าลองทำ) ต้องสร้าง LIFF ไว้ใน **LINE Login channel** แยกต่างหากแทน — แต่อยู่ **Provider เดียวกัน** กับ Messaging API channel ได้ตามปกติ

**กรณีนี้ไม่ต้องสร้างใหม่** — ตอนสร้าง channel "Bill Tracker" ครั้งแรกในขั้นตอนก่อนหน้านี้ เคยสร้างพลาดเป็นชนิด LINE Login ไว้ก่อนแล้ว (ก่อนจะสร้าง Messaging API channel แยกอีกอันถูกต้อง) channel LINE Login ตัวนั้นยังอยู่ดี ใช้ตัวนั้นได้เลย:

1. เข้า [LINE Developers Console](https://developers.line.biz/console/) → Provider เดียวกับ channel "Bill-Tracker" (Messaging API) → จะเห็น channel "Bill Tracker" ชนิด **LINE Login** อยู่ในลิสต์ด้วย (ถ้าหาไม่เจอหรือลบไปแล้ว ให้สร้างใหม่: **Create a new channel** → เลือกชนิด **LINE Login** → ตั้งชื่อใดก็ได้)
2. เข้า channel "Bill Tracker" (LINE Login) → แท็บ **LIFF** → Add
   - Endpoint URL: ใส่ไปก่อนชั่วคราว เช่น `https://example.com` (จะแก้เป็น URL จริงหลัง deploy)
   - Size: **Full**
   - Scope: เลือก `openid`, `profile`
   - กดสร้าง → จะได้ **LIFF ID** (รูปแบบ `1234567890-AbCdEfGh`) → นี่คือ `LIFF_ID`
3. ในแท็บ **Basic settings** ของ channel นี้ (LINE Login) → จด **Channel ID** (เลขล้วน) ไว้ → นี่คือ `LIFF_CHANNEL_ID` (เป็นคนละค่ากับ channel ID ของ Messaging API channel ในขั้นตอน 1 — ใช้ของ LINE Login channel เท่านั้น)

> **ทำไมต้องแยก channel:** เพราะแยก channel กัน LINE จะออก userId คนละชุดให้คนๆเดียวกัน — userId ตอนแชทกับบอท (Messaging API) กับ userId ตอนเปิดหน้า LIFF (LINE Login) จะไม่เท่ากัน ระบบในโฟลเดอร์นี้แก้ปัญหานี้ไว้ให้แล้วด้วยขั้นตอน **"เชื่อมต่อบัญชี"** อัตโนมัติ — ผู้ใช้แค่กดปุ่มในแชทครั้งเดียวตอนเริ่มใช้ครั้งแรก (ดูขั้นตอน 5) ไม่ต้องทำอะไรเพิ่มหลังจากนั้น

### 3. Deploy ขึ้น Render (มี free tier ไม่ต้องผูกบัตรเครดิต)

1. สร้างบัญชีที่ [render.com](https://render.com) (ผูกกับ GitHub ได้เลย)
2. Push โฟลเดอร์นี้ขึ้น GitHub repo ใหม่ (แยกจาก repo เว็บแอปเดิม `Bill-Tracker` ก็ได้ เพื่อไม่ปนกัน)
3. ใน Render: **New > Blueprint** → เลือก repo นี้ → Render จะอ่าน `render.yaml` แล้วสร้างให้อัตโนมัติ 2 อย่าง:
   - Web Service (รัน `server.js`)
   - PostgreSQL database (free)
4. ตั้งค่า Environment Variables ของ Web Service ให้ครบ (ตามที่ได้จากขั้นตอน 1-2):
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
   - `LIFF_ID`
   - `LIFF_CHANNEL_ID`
   - (`DATABASE_URL` Render เติมให้เองจาก database ที่สร้างคู่กัน)
   - (`BASE_URL` ไม่ต้องตั้งเอง — Render เติม URL ของเว็บเซอร์วิสนี้ให้อัตโนมัติ ใช้สำหรับสร้างลิงก์หน้า "เชื่อมต่อบัญชี")
5. Deploy แล้วรอจนสถานะเป็น **Live** — จะได้ URL ของแอป เช่น `https://bill-tracker-line-bot.onrender.com`

> Free tier ของ Render จะ "หลับ" ถ้าไม่มีคนใช้นานๆ ครั้งแรกที่มีคนส่งรูป/พิมพ์มาหลังจากหลับ บอทอาจตอบช้าไปประมาณ 30-60 วินาที (ครั้งต่อๆไปเร็วปกติ) ถ้าอยากให้ตอบเร็วทันทีตลอด อัปเกรดเป็น Starter plan (~$7/เดือน) ได้ทีหลังโดยไม่ต้องแก้โค้ดอะไร

### 4. กลับไปผูก URL จริงในฝั่ง LINE

1. ใน LINE Login channel (จากขั้นตอน 2) → แท็บ **LIFF** → แก้ Endpoint URL เป็น URL จาก Render (ขั้นตอน 3.5) เช่น `https://bill-tracker-line-bot.onrender.com`
2. ใน Messaging API channel (จากขั้นตอน 1) → แท็บ **Messaging API** → ตั้ง **Webhook URL** เป็น `https://bill-tracker-line-bot.onrender.com/webhook` → กด Verify ให้ขึ้นเครื่องหมายถูก
3. ไม่ต้องแก้โค้ดอะไรเพิ่ม — หน้า LIFF ดึงค่า `LIFF_ID` จาก environment variable ที่ตั้งไว้ในขั้นตอน 3 โดยอัตโนมัติผ่าน `/api/config`

### 5. เพิ่มบอทเป็นเพื่อนแล้วทดสอบ

1. ในแท็บ **Messaging API** จะมี QR code ของ Official Account → สแกนเพิ่มเป็นเพื่อนด้วย LINE ของคุณ (และคนในบ้าน/คนที่ต้องหารบิลด้วยกัน)
2. **ครั้งแรกที่เพิ่มเป็นเพื่อน** บอทจะส่งข้อความทักทาย + ปุ่ม **"เชื่อมต่อบัญชี"** มาให้ — ให้กดปุ่มนี้ก่อน (ทำครั้งเดียวเท่านั้น ต่อไปไม่ต้องกดอีก) ระบบจะพาไปหน้ายืนยันตัวตนสั้นๆแล้วเด้งกลับมาที่แชทอัตโนมัติ พร้อมข้อความ "เชื่อมต่อบัญชีสำเร็จ"
3. ลองส่งรูปบิลในแชท → บอทควรตอบกลับเป็นปุ่ม "ตรวจสอบบิล" → กดปุ่มจะเปิดหน้า LIFF พร้อมรูปและรันอ่านบิล (OCR) ให้อัตโนมัติเหมือนเว็บแอปเดิม
4. ลองพิมพ์ข้อความอะไรก็ได้ → บอทควรตอบปุ่ม "เปิดแอป" ไปหน้ารวมบิล/สรุปยอด

### 6. ตั้งแจ้งเตือนก่อนวันครบกำหนด (ส่งเป็นข้อความ LINE อัตโนมัติ)

ระบบเช็คและส่งแจ้งเตือนอยู่ในโค้ดแล้ว (เตือนตอนเหลือ 3 วันก่อนครบกำหนด ส่งตอน 9 โมงเช้า แยกตามบัตรที่ยังไม่ได้กดจ่าย) แต่ตัว "นาฬิกาปลุก" ที่สั่งให้เช็คทุกวันต้องตั้งเองข้างนอก เพราะ Render free tier ไม่มี cron job ในตัวที่ฟรี — ใช้บริการฟรี [cron-job.org](https://cron-job.org) ยิง request มาแทน:

1. ตั้งค่า Environment Variable เพิ่มอีกตัวในหน้า Render (Web Service > Environment): `CRON_SECRET` = `974a892fc05e71276d03439fb46c497a57038a94452f8c3a` (หรือสุ่มค่าใหม่ของตัวเองก็ได้ แค่ต้องใช้ค่าเดียวกันกับขั้นตอนถัดไป) → Save จะ redeploy ให้อัตโนมัติ
2. สมัครบัญชีฟรีที่ [cron-job.org](https://cron-job.org)
3. กด **Create cronjob**
   - URL: `https://bill-tracker-line-bot.onrender.com/api/cron/notify-due?key=974a892fc05e71276d03439fb46c497a57038a94452f8c3a` (เปลี่ยนเป็นโดเมนจริงของคุณ และ key ให้ตรงกับขั้นตอน 1)
   - Schedule: ทุกวัน เวลา **09:00**, Timezone: **Asia/Bangkok**
   - Save
4. ทดสอบโดยกด "Execute now" ในหน้า cron-job.org แล้วเช็คว่า response เป็น `{"ok":true,...}` (ไม่ใช่ 401 — ถ้า 401 แปลว่า key ไม่ตรงกับที่ตั้งใน Render)

> ข้อความแจ้งเตือนใช้ "push message" ของ LINE ซึ่งแพ็กเกจฟรีของ LINE Official Account ให้ส่งได้ 300 ข้อความ/เดือน (รวมทุกฟีเจอร์ที่ส่งแบบ push/broadcast) ใช้ส่วนตัวแบบนี้ไม่มีทางชนโควต้านี้แน่นอน

---

## ย้ายข้อมูลเก่าจากเว็บแอป (index.html เดิม)

หน้า LIFF ใหม่มีเมนู "สำรองข้อมูล" เหมือนเว็บแอปเดิมทุกอย่าง (import/export เป็น JSON) ใช้ย้ายข้อมูลได้เลย:

1. เปิดเว็บแอปเดิม → เมนูสำรองข้อมูล → กด "คัดลอก"
2. เปิดบอทใน LINE → เปิดแอป (LIFF) → เมนูสำรองข้อมูล → วางข้อมูลที่คัดลอกมาในกล่อง "นำเข้าข้อมูล" → กดนำเข้า

รายการที่ id ซ้ำกันจะไม่ถูกเพิ่มซ้ำ ทำได้หลายครั้งถ้าต้องการ

---

## โครงสร้างไฟล์

```
line-bill-bot/
├── server.js          ตัวเซิร์ฟเวอร์: webhook + REST API
├── db.js              เชื่อม PostgreSQL, สร้างตาราง, query ทั้งหมด
├── package.json
├── render.yaml         ใช้ตอน deploy แบบ Blueprint บน Render
├── .env.example        รายชื่อ environment variables ที่ต้องตั้ง
└── public/
    ├── index.html      หน้าแอป (LIFF) — โค้ดเดิมของเว็บแอปเกือบทั้งหมด
    │                    แก้แค่ส่วนโหลด/บันทึกข้อมูลให้คุยกับเซิร์ฟเวอร์
    │                    แทน localStorage และเพิ่มการรับรูปจาก LINE
    └── link.html       หน้า "เชื่อมต่อบัญชี" — ใช้ครั้งเดียวตอนเริ่มใช้งานครั้งแรก
                         เพื่อผูก userId ฝั่งแชทกับฝั่ง LIFF เข้าด้วยกัน
```

## ความปลอดภัย

- **ห้าม commit ไฟล์ `.env` หรือใส่ token/secret ลงในโค้ดที่ push ขึ้น GitHub** — ตั้งผ่าน Environment Variables ในหน้า Render เท่านั้น (มี `.env.example` ไว้เป็นแค่ตัวอย่างชื่อตัวแปร ไม่มีค่าจริง)
- ทุก request ไปยัง `/api/data` และ `/api/pending/*` ต้องแนบ LIFF ID token ซึ่งเซิร์ฟเวอร์ตรวจสอบกับ LINE ทุกครั้ง — แต่ละคนเห็นได้แค่ข้อมูลของตัวเอง
- ถ้า token หลุดหรือสงสัยว่ามีปัญหา ไป Issue token ใหม่ในหน้า Messaging API ได้ทันที (ของเก่าจะใช้ไม่ได้)
