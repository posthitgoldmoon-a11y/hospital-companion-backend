const express = require('express');
const router = express.Router();
const { chat } = require('../services/gemini');
require('dotenv').config();

const sessions = {};

router.get('/welcome', (req, res) => {
  res.json({
    reply: "안녕하세요! 연세푸르미피부과입니다 😊\nHello! Welcome to Yonsei Purumi Clinic!\n\n언어를 선택해주세요\nPlease select your language",
    buttons: [
      { label: '🇰🇷 한국어', message: '__lang_ko__' },
      { label: '🇺🇸 English', message: '__lang_en__' },
      { label: '🇨🇳 中文', message: '__lang_zh__' },
      { label: '🇯🇵 日本語', message: '__lang_ja__' },
      { label: '🇹🇭 ภาษาไทย', message: '__lang_th__' },
      { label: '🇻🇳 Tiếng Việt', message: '__lang_vi__' },
      { label: '🇸🇦 العربية', message: '__lang_ar__' },
      { label: '🇷🇺 Русский', message: '__lang_ru__' },
      { label: '🇫🇷 Français', message: '__lang_fr__' },
      { label: '🇪🇸 Español', message: '__lang_es__' }
    ]
  });
});

router.post('/api', async (req, res) => {
  try {
    const { message, userId } = req.body;
    if (!message || !userId) return res.json({ reply: '메시지를 입력해주세요.', buttons: null });

    if (!sessions[userId]) sessions[userId] = { history: [], booted: false, lang: null, awaitingBooking: false };
    const session = sessions[userId];

    // 언어 선택 처리
    const msg = message.trim();
    const langMap = {
      '__lang_ko__': 'ko', '__lang_en__': 'en', '__lang_zh__': 'zh',
      '__lang_ja__': 'ja', '__lang_th__': 'th', '__lang_vi__': 'vi',
      '__lang_ar__': 'ar', '__lang_ru__': 'ru', '__lang_fr__': 'fr', '__lang_es__': 'es'
    };
    const langGreet = {
      ko: "한국어로 안내해드릴게요 😊\n무엇을 도와드릴까요?",
      en: "I will assist you in English 😊\nHow can I help you?",
      zh: "我将用中文为您服务 😊\n请问有什么可以帮您？",
      ja: "日本語でご案内します 😊\nどのようなご用件でしょうか？",
      th: "ฉันจะช่วยคุณเป็นภาษาไทย 😊\nฉันจะช่วยคุณได้อย่างไร？",
      vi: "Tôi sẽ hỗ trợ bạn bằng tiếng Việt 😊\nTôi có thể giúp gì cho bạn？",
      ar: "سأساعدك باللغة العربية 😊\nكيف يمكنني مساعدتك؟",
      ru: "Я помогу вам на русском языке 😊\nЧем могу помочь？",
      fr: "Je vais vous aider en français 😊\nComment puis-je vous aider？",
      es: "Le ayudaré en español 😊\n¿En qué puedo ayudarle？"
    };
    const langMenuButtons = {
      ko: [
        { label: '📅 예약하기', message: '예약할게요' },
        { label: '💬 피부 상담', message: '피부 상담 받고 싶어요' },
        { label: '💰 가격 안내', message: '가격 알려주세요' },
        { label: '👨‍⚕️ 의료진 소개', message: '의료진 소개해주세요' },
        { label: '📍 오시는 길', message: '위치 알려주세요' },
        { label: '⏰ 진료시간', message: '진료시간 알려주세요' }
      ],
      en: [
        { label: '📅 Reservation', message: 'I want to make a reservation' },
        { label: '💬 Consultation', message: 'I want skin consultation' },
        { label: '💰 Pricing', message: 'Tell me about pricing' },
        { label: '👨‍⚕️ Doctors', message: 'Introduce the doctors' },
        { label: '📍 Location', message: 'How do I get there' },
        { label: '⏰ Hours', message: 'What are the clinic hours' }
      ],
      zh: [
        { label: '📅 预约', message: '我想预约' },
        { label: '💬 咨询', message: '我想咨询皮肤问题' },
        { label: '💰 价格', message: '请告诉我价格' },
        { label: '👨‍⚕️ 医生介绍', message: '介绍一下医生' },
        { label: '📍 位置', message: '怎么去' },
        { label: '⏰ 营业时间', message: '营业时间是什么' }
      ],
      ja: [
        { label: '📅 予約', message: '予約したいです' },
        { label: '💬 相談', message: '肌の相談がしたいです' },
        { label: '💰 料金', message: '料金を教えてください' },
        { label: '👨‍⚕️ 医師紹介', message: '医師を紹介してください' },
        { label: '📍 アクセス', message: '行き方を教えてください' },
        { label: '⏰ 診療時間', message: '診療時間を教えてください' }
      ]
    };
    // 기타 언어는 영어 메뉴 사용
    ['th','vi','ar','ru','fr','es'].forEach(l => { if (!langMenuButtons[l]) langMenuButtons[l] = langMenuButtons.en; });

    if (langMap[msg]) {
      session.lang = langMap[msg];
      session.history = [];
      session.booted = false;
      return res.json({
        reply: langGreet[session.lang],
        buttons: langMenuButtons[session.lang]
      });
    }

    // 예약 의사 표현 직접 처리 (Gemini 우회)
    const bookingTriggers = ['새로 예약', '예약할게요', '예약하고 싶어요', '예약 원해요', '예약해주세요', '예약하겠습니다', '예약 도와주세요'];
    const isBookingTrigger = bookingTriggers.some(k => msg.includes(k));

    // Gemini가 "예약하시겠어요?" 물었을 때 긍정 답변 처리
    const positiveAnswers = ['네', '응', '예', '좋아요', '할게요', '부탁해요', 'yes', 'ok', 'okay', 'sure'];
    const isPositive = positiveAnswers.some(k => msg === k || msg === k + '.' || msg === k + '!');
    if (session.awaitingBooking && isPositive) {
      session.awaitingBooking = false;
      const naverUrl = process.env.NAVER_BOOKING_URL || 'https://booking.naver.com';
      const lang2 = session.lang || 'ko';
      const replyMap2 = {
        ko: '예약은 아래 버튼을 통해 진행해주세요 😊',
        en: 'Please use the buttons below to make a reservation 😊',
        zh: '请点击下方按钮进行预约 😊',
        ja: '下のボタンから予約をお進めください 😊',
        th: 'กรุณาใช้ปุ่มด้านล่างเพื่อทำการจอง 😊',
        vi: 'Vui lòng su dung nut ben duoi de dat lich 😊',
        ar: 'يرجى استخدام الأزرار أدناه للحجز 😊',
        ru: 'Используйте кнопки ниже для записи 😊',
        fr: 'Veuillez utiliser les boutons ci-dessous 😊',
        es: 'Use los botones de abajo para reservar 😊'
      };
      return res.json({
        reply: replyMap2[lang2] || replyMap2.ko,
        buttons: [
          { label: '📅 네이버 예약', url: naverUrl },
          { label: '💬 카카오채널 예약', url: 'https://pf.kakao.com/_bookit' }
        ]
      });
    }

    if (isBookingTrigger) {
      const naverUrl = process.env.NAVER_BOOKING_URL || 'https://booking.naver.com';
      const lang2 = session.lang || 'ko';
      const replyMap2 = {
        ko: '예약은 아래 버튼을 통해 진행해주세요 😊',
        en: 'Please use the buttons below to make a reservation 😊',
        zh: '请点击下方按钮进行预约 😊',
        ja: '下のボタンから予約をお進めください 😊',
        th: 'กรุณาใช้ปุ่มด้านล่างเพื่อทำการจอง 😊',
        vi: 'Vui lòng sử dung nut ben duoi de dat lich 😊',
        ar: 'يرجى استخدام الأزرار أدناه للحجز 😊',
        ru: 'Используйте кнопки ниже для записи 😊',
        fr: 'Veuillez utiliser les boutons ci-dessous 😊',
        es: 'Use los botones de abajo para reservar 😊'
      };
      return res.json({
        reply: replyMap2[lang2] || replyMap2.ko,
        buttons: [
          { label: '📅 네이버 예약', url: naverUrl },
          { label: '💬 카카오채널 예약', url: 'https://pf.kakao.com/_bookit' }
        ]
      });
    }

    // 네이버 예약 키워드 직접 처리
    if (msg.includes('네이버')) {
      const naverUrl = process.env.NAVER_BOOKING_URL || 'https://booking.naver.com';
      return res.json({
        reply: '네이버 예약 페이지로 이동합니다! 😊',
        buttons: [{ label: '👉 네이버 예약하기', url: naverUrl }]
      });
    }
    if (msg.includes('카카오')) {
      return res.json({
        reply: '카카오채널로 예약하실 수 있어요! 😊',
        buttons: [{ label: '💬 카카오채널 예약', url: 'https://pf.kakao.com/_bookit' }]
      });
    }

    const lang = session.lang || 'ko';
    const geminiReply = await chat(session.history, message, session.booted, 'hospital', lang);
    session.history.push({ role: 'user', content: message });
    session.history.push({ role: 'model', content: geminiReply.message });
    if (session.history.length > 20) session.history = session.history.slice(-20);
    session.booted = true;

    let buttons = null;
    if (geminiReply.showBookingType) {
      const hasQuestion = geminiReply.message.includes('?') || geminiReply.message.includes('어떤') || geminiReply.message.includes('부위');
      if (!hasQuestion) {
        buttons = [
          { label: '📅 네이버 예약', url: process.env.NAVER_BOOKING_URL || 'https://booking.naver.com' },
          { label: '💬 카카오채널 예약', url: 'https://pf.kakao.com/_bookit' }
        ];
      }
    } else if (geminiReply.showDoctors) {
      buttons = [
        { label: '김연세 원장', message: '김연세 원장님으로 예약할게요' },
        { label: '박푸르미 원장', message: '박푸르미 원장님으로 예약할게요' },
        { label: '이미소 원장', message: '이미소 원장님으로 예약할게요' }
      ];
    }

    // Gemini가 예약 권유하면 awaitingBooking 설정
    const bookingQ = ['예약하시겠어요', '예약 도와드릴까요', '예약을 원하시나요', 'Would you like to make', 'reservation'];
    if (bookingQ.some(q => geminiReply.message.includes(q))) {
      session.awaitingBooking = true;
    }
    // 예약 유도 문구 강제 제거
    let cleanReply = geminiReply.message
      .replace(/\s*혹시 새로 예약하시겠어요\?/g, '')
      .replace(/\s*새로 예약하시겠어요\?/g, '')
      .replace(/\s*예약하시겠어요\?/g, '')
      .replace(/\s*예약을 도와드릴까요\?/g, '')
      .replace(/\s*예약 도와드릴까요\?/g, '')
      .replace(/\s*Would you like to make a reservation\?/g, '')
      .replace(/\s*Would you like to book\?/g, '')
      .trim();
    res.json({ reply: cleanReply, buttons });
  } catch(e) {
    console.error('chatdemo 오류:', e.message);
    res.json({ reply: '잠시 후 다시 시도해주세요.', buttons: null });
  }
});

router.get('/', (req, res) => {
  const naverUrl = process.env.NAVER_BOOKING_URL || 'https://booking.naver.com';
  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>연세푸르미피부과 AI 상담</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:'Apple SD Gothic Neo',sans-serif; background:#f0f2f5; display:flex; flex-direction:column; height:100vh; }
.header { background:#00C4B4; color:white; padding:16px; text-align:center; font-size:16px; font-weight:bold; }
.messages { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
.msg { max-width:75%; padding:10px 14px; border-radius:18px; font-size:14px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
.bot { background:white; align-self:flex-start; border-bottom-left-radius:4px; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
.user { background:#00C4B4; color:white; align-self:flex-end; border-bottom-right-radius:4px; }
.btn-group { display:flex; flex-wrap:wrap; gap:6px; margin-top:4px; align-self:flex-start; }
.btn-group button { background:white; border:1.5px solid #00C4B4; color:#00C4B4; padding:7px 12px; border-radius:16px; font-size:13px; cursor:pointer; transition:all .2s; }
.btn-group button:hover { background:#00C4B4; color:white; }
.input-area { display:flex; padding:12px; background:white; border-top:1px solid #e0e0e0; gap:8px; }
.input-area input { flex:1; padding:10px 14px; border:1.5px solid #ddd; border-radius:20px; font-size:14px; outline:none; }
.input-area input:focus { border-color:#00C4B4; }
.input-area button { background:#00C4B4; color:white; border:none; padding:10px 18px; border-radius:20px; font-size:14px; cursor:pointer; }
</style>
</head>
<body>
<div class="header">💬 연세푸르미피부과 AI 상담</div>
<div class="messages" id="messages"></div>
<div class="input-area">
  <input id="input" placeholder="메시지를 입력하세요..." onkeydown="if(event.key==='Enter') sendMsg()">
  <button onclick="sendMsg()">전송</button>
</div>
<script>
const userId = 'demo_' + Math.random().toString(36).substr(2,9);
const naverUrl = '${naverUrl}';

async function loadWelcome() {
  try {
    const res = await fetch('/chat-demo/welcome');
    const data = await res.json();
    addMsg(data.reply, 'bot');
    if (data.buttons) addButtons(data.buttons);
  } catch(e) { addMsg('안녕하세요! 무엇을 도와드릴까요? 😊', 'bot'); }
}

async function sendMsg() {
  const input = document.getElementById('input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (!text.startsWith('__lang_')) addMsg(text, 'user');
  try {
    const res = await fetch('/chat-demo/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, userId })
    });
    const data = await res.json();
    addMsg(data.reply, 'bot');
    if (data.buttons) addButtons(data.buttons);
  } catch(e) { addMsg('오류가 발생했습니다. 다시 시도해주세요.', 'bot'); }
}

function addMsg(text, type) {
  const div = document.createElement('div');
  div.className = 'msg ' + type;
  div.textContent = text;
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
}

function addButtons(buttons) {
  const group = document.createElement('div');
  group.className = 'btn-group';
  buttons.forEach(btn => {
    const b = document.createElement('button');
    b.textContent = btn.label;
    if (btn.url) {
      b.onclick = () => window.open(btn.url, '_blank');
    } else if (btn.message) {
      b.onclick = () => {
        document.getElementById('input').value = btn.message;
        sendMsg();
      };
    }
    group.appendChild(b);
  });
  document.getElementById('messages').appendChild(group);
  scrollToBottom();
}

function scrollToBottom() {
  const m = document.getElementById('messages');
  m.scrollTop = m.scrollHeight;
}

loadWelcome();
</script>
</body>
</html>`);
});

module.exports = router;
