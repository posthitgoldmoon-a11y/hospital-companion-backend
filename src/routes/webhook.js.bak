const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const { chat } = require("../services/gemini");
const { findAvailableManager } = require("../services/manager-filter");
const { createBooking, assignManager } = require("../models/booking");
const { findOrCreateCustomer } = require("../models/customer");
const { makeTextResponse, makeBookingConfirmResponse, sendManagerNotification } = require("../services/kakao-api");
const pool = require("../services/db");

const sessions = {};

const REQUIRED_FIELDS = ["patient_name", "age", "hospital", "region", "date", "time", "duration", "service_type"];

const MANAGER_STEPS = [
  { field: "name", question: "매니저 성함이 어떻게 되시나요?" },
  { field: "phone", question: "연락처를 입력해주세요. (예: 010-1234-5678)" },
  { field: "regions", question: "담당 가능한 지역을 선택해주세요.\n(복수 선택 가능, 쉼표로 구분)\n예: 서울, 경기" },
  { field: "days", question: "가능한 요일을 선택해주세요.\n(복수 선택 가능, 쉼표로 구분)\n예: 월, 화, 수, 목, 금" },
  { field: "times", question: "가능한 시간대를 선택해주세요.\n(복수 선택 가능, 쉼표로 구분)\n예: 오전, 오후, 저녁" },
  { field: "service_type", question: "제공 가능한 서비스를 선택해주세요.\n1. 기사동행 포함\n2. 기사동행 미포함\n3. 둘 다 가능" },
];

function isComplete(data) {
  if (!data) return false;
  return REQUIRED_FIELDS.every(f => data[f] !== null && data[f] !== undefined && data[f] !== "null");
}

function mergeData(existing, newData) {
  if (!newData) return existing;
  const merged = { ...existing };
  for (const key of REQUIRED_FIELDS) {
    if (newData[key] !== null && newData[key] !== undefined && newData[key] !== "null") {
      merged[key] = newData[key];
    }
  }
  return merged;
}

async function isManager(kakaoUserId) {
  const [rows] = await pool.query(
    "SELECT * FROM managers WHERE kakao_user_id = ?",
    [kakaoUserId]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function finalizeBooking(session, kakaoUserId) {
  const customer = await findOrCreateCustomer(kakaoUserId);
  const booking = await createBooking({
    customer_id: customer.id,
    ...session.data,
    duration: parseInt(session.data.duration) || 2,
    service_type: parseInt(session.data.service_type) || 2,
    kakao_user_id: kakaoUserId,
  });

  const manager = await findAvailableManager(session.data.region, parseInt(session.data.service_type), session.data.date, session.data.time);

  if (!manager) {
    sessions[kakaoUserId] = { history: [], data: {}, booked: false };
    return makeTextResponse("죄송합니다. 현재 해당 지역에 가능한 매니저가 없습니다.\n잠시 후 다시 시도해주세요.");
  }

  // 매니저에게 콜 발송 (수락 전까지 배정 안 함)
  sendManagerNotification(manager, { ...booking, region: session.data.region });
  session.data = {};
  session.booted = true;
  const serviceText = booking.service_type == 1 ? '기사동행 포함' : '기사동행 미포함';
  const specialText = booking.special_requests ? `\n⚠️ 요청사항: ${booking.special_requests}` : '';
  return makeTextResponse(
    '✅ 예약 접수가 완료되었습니다!\n\n' +
    `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
    `🏥 병원: ${booking.hospital} (${booking.region})\n` +
    `📅 날짜: ${booking.date} ${booking.time}\n` +
    `🚗 서비스: ${serviceText}\n` +
    `⏱ 이용시간: ${booking.duration}시간` +
    `${specialText}\n\n` +
    `예약번호: ${booking.id}\n\n` +
    '매니저님께 콜을 발송했습니다.\n곧 연락드리겠습니다 😊'
  );
}

async function handleManagerRegistration(session, kakaoUserId, userMessage) {
  const currentStep = MANAGER_STEPS[session.managerStep];

  // 입력값 저장
  session.managerData[currentStep.field] = userMessage.trim();
  session.managerStep++;

  // 다음 질문
  if (session.managerStep < MANAGER_STEPS.length) {
    return makeTextResponse(MANAGER_STEPS[session.managerStep].question);
  }

  // 모든 정보 수집 완료 → DB 저장
  const d = session.managerData;
  const serviceType = d.service_type.includes("3") ? 0 :
                      d.service_type.includes("1") ? 1 : 2;

  await pool.query(
    `INSERT INTO managers (name, phone, filter_regions, available_days, available_times, service_type, status, kakao_user_id)
     VALUES (?, ?, ?, ?, ?, ?, 'online', ?)`,
    [
      d.name,
      d.phone,
      JSON.stringify(d.regions.split(",").map(r => r.trim())),
      JSON.stringify(d.days.split(",").map(r => r.trim())),
      JSON.stringify(d.times.split(",").map(r => r.trim())),
      serviceType,
      kakaoUserId
    ]
  );

  sessions[kakaoUserId] = { history: [], data: {}, booked: false, isManager: true };

  return makeTextResponse(
    `✅ 매니저 등록이 완료되었습니다!\n\n` +
    `👤 이름: ${d.name}\n` +
    `📞 연락처: ${d.phone}\n` +
    `📍 담당 지역: ${d.regions}\n` +
    `📅 가능 요일: ${d.days}\n` +
    `⏰ 가능 시간: ${d.times}\n\n` +
    `예약 콜이 들어오면 바로 알려드리겠습니다! 🔔`
  );
}

async function processAndCallback(kakaoUserId, userMessage, callbackUrl) {
  try {
    const isNewSession = !sessions[kakaoUserId];
    if (!sessions[kakaoUserId]) {
      sessions[kakaoUserId] = { history: [], data: {}, booted: false };
    }
    const session = sessions[kakaoUserId];

    // 첫 진입 시 캐러셀 카드 보여주기
    if (isNewSession) {
      const carouselResponse = {
        version: "2.0",
        template: {
          outputs: [
            {
              simpleText: {
                text: "안녕하세요! 돈워리 병원동행 서비스입니다 😊\n접수부터 수납까지 보호자처럼 함께해드립니다."
              }
            },
            {
              carousel: {
                type: "basicCard",
                items: [
                  {
                    title: "📅 예약하기",
                    description: "병원동행 예약을 도와드립니다",
                    buttons: [{ action: "message", label: "예약 시작", messageText: "예약하고 싶어요" }]
                  },
                  {
                    title: "💬 문의하기",
                    description: "서비스 관련 궁금한 점을 물어보세요",
                    buttons: [{ action: "message", label: "문의하기", messageText: "문의가 있어요" }]
                  },
                  {
                    title: "💰 요금안내",
                    description: "서비스 요금을 확인해보세요",
                    buttons: [{ action: "message", label: "요금 확인", messageText: "요금이 어떻게 되나요?" }]
                  },
                  {
                    title: "👩‍💼 직원연결",
                    description: "상담원과 직접 연결해드립니다",
                    buttons: [{ action: "message", label: "직원 연결", messageText: "직원 연결해주세요" }]
                  }
                ]
              }
            }
          ]
        }
      };
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(carouselResponse)
      });
      return;
    }

    // 매니저 등록 진행 중
    if (session.step === "manager_registration") {
      const response = await handleManagerRegistration(session, kakaoUserId, userMessage);
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response)
      });
      return;
    }

    // "매니저등록" 키워드 감지
    if (userMessage.trim() === "매니저등록") {
      session.step = "manager_registration";
      session.managerStep = 0;
      session.managerData = {};
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTextResponse(
          "매니저 등록을 시작합니다! 👋\n\n" + MANAGER_STEPS[0].question
        ))
      });
      return;
    }

    // Gemini 처리 시작 로그
    console.log("processAndCallback 시작:", kakaoUserId, userMessage);

    // 매니저 여부 확인
    const managerInfo = await isManager(kakaoUserId);
    if (managerInfo) {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTextResponse(
          `안녕하세요 ${managerInfo.name} 매니저님! 👋\n\n현재 배정된 예약을 확인하려면 "내 예약"이라고 입력해주세요.`
        ))
      });
      return;
    }

    // 고객 예약 흐름
    // 내 예약 조회 요청 감지
    const isMyBookingRequest = /내.*예약|예약.*내역|예약.*확인|예약.*조회|예약.*보여|내가.*예약|나.*예약/.test(userMessage);
    if (isMyBookingRequest) {
      const db = require('../services/db');
      const userKey = kakaoUserId;
      const [rows] = await db.query(
        'SELECT * FROM bookings WHERE kakao_user_id = ? ORDER BY created_at DESC LIMIT 5',
        [userKey]
      );
      let replyMsg = '';
      if (rows.length === 0) {
        replyMsg = '아직 예약 내역이 없습니다 😊\n새로운 예약을 원하시면 환자분 성함과 나이를 알려주세요!';
      } else {
        replyMsg = '📋 예약 내역입니다!\n\n';
        rows.forEach((b, i) => {
          const status = b.status === 'confirmed' ? '✅ 확정' : b.status === 'pending' ? '⏳ 대기중' : b.status === 'cancelled' ? '❌ 취소' : b.status;
          replyMsg += (i+1) + '. ' + b.date + ' ' + b.time + '\n' +
            '   환자: ' + b.patient_name + ' (' + b.age + '세)\n' +
            '   병원: ' + b.hospital + ' (' + b.region + ')\n' +
            '   서비스: ' + (b.service_type == 1 ? '기사동행 포함' : '기사동행 미포함') + '\n' +
            '   상태: ' + status + '\n\n';
        });
      }
      if (callbackUrl) {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } })
        });
      } else {
        return res.json({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } });
      }
      return;
    }

    const { message, bookingData, showDriverButtons, humanAgentRequest } = await chat(session.history, userMessage, session.booked);
    session.data = mergeData(session.data, bookingData);
    session.history.push({ role: "user", content: userMessage });
    session.history.push({ role: "model", content: message });
    if (session.history.length > 20) session.history = session.history.slice(-20);

    if (!session.booked && isComplete(session.data)) {
      const confirmResponse = await finalizeBooking(session, kakaoUserId);
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmResponse)
      });
    } else {
      // 기사동행 여부 질문일 때 퀵리플라이 버튼 추가
      // 상담원 연결 요청 감지
      if (humanAgentRequest) {
        const telegramMsg = `🚨 상담원 연결 요청!\n\n👤 고객 발화: "${userMessage}"\n\n💬 최근 대화:\n${session.history.slice(-4).map(h => `  ${h.role === 'user' ? '고객' : '봇'}: ${h.parts && h.parts[0] ? h.parts[0].text : ''}`).join('\n')}\n\n👉 center-pf.kakao.com 에서 채팅 확인하세요`;
        const adminIds = process.env.TELEGRAM_ADMIN_CHAT_ID ? process.env.TELEGRAM_ADMIN_CHAT_ID.split(',') : [];
        for (const adminId of adminIds) {
          await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: adminId.trim(), text: telegramMsg })
          });
        }
      }
      let response;
      if (showDriverButtons) {
        response = {
          version: "2.0",
          template: {
            outputs: [{ simpleText: { text: message } }],
            quickReplies: [
              { label: "🚗 기사 포함", action: "message", messageText: "기사 포함" },
              { label: "🚶 기사 미포함", action: "message", messageText: "기사 미포함" }
            ]
          }
        };
      } else {
        response = makeTextResponse(message);
      }
      
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(response)
      });
    }

  } catch (err) {
    console.error("처리 오류:", err);
    try {
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTextResponse("일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요."))
      });
    } catch (e) {
      console.error("콜백 전송 실패:", e);
    }
  }
}

router.post("/", async (req, res) => {
  try {
    const body = req.body;
    const userRequest = body.userRequest;
    const kakaoUserId = userRequest.user.id;
    const userMessage = userRequest.utterance.trim();
    const callbackUrl = userRequest.callbackUrl;
    console.log("callbackUrl:", callbackUrl, "userMessage:", userMessage);

    if (!callbackUrl) {
      if (!sessions[kakaoUserId]) {
        sessions[kakaoUserId] = { history: [], data: {}, booked: false };
        // 첫 진입 시 캐러셀 카드 보여주기
        return res.json({
          version: "2.0",
          template: {
            outputs: [
              {
                simpleText: {
                  text: "안녕하세요! 돈워리 병원동행 서비스입니다 😊\n접수부터 수납까지 보호자처럼 함께해드립니다."
                }
              },
              {
                carousel: {
                  type: "basicCard",
                  items: [
                    {
                      title: "📅 예약하기",
                      description: "병원동행 예약을 도와드립니다",
                      buttons: [{ action: "message", label: "예약 시작", messageText: "예약하고 싶어요" }]
                    },
                    {
                      title: "💬 문의하기",
                      description: "서비스 관련 궁금한 점을 물어보세요",
                      buttons: [{ action: "message", label: "문의하기", messageText: "문의가 있어요" }]
                    },
                    {
                      title: "💰 요금안내",
                      description: "서비스 요금을 확인해보세요",
                      buttons: [{ action: "message", label: "요금 확인", messageText: "요금이 어떻게 되나요?" }]
                    },
                    {
                      title: "👩‍💼 직원연결",
                      description: "상담원과 직접 연결해드립니다",
                      buttons: [{ action: "message", label: "직원 연결", messageText: "직원 연결해주세요" }]
                    }
                  ]
                }
              }
            ]
          }
        });
      }
      const session = sessions[kakaoUserId];

      if (session.step === "manager_registration") {
        const response = await handleManagerRegistration(session, kakaoUserId, userMessage);
        return res.json(response);
      }

      if (userMessage.trim() === "매니저등록") {
        session.step = "manager_registration";
        session.managerStep = 0;
        session.managerData = {};
        return res.json(makeTextResponse("매니저 등록을 시작합니다! 👋\n\n" + MANAGER_STEPS[0].question));
      }

      // 내 예약 조회 요청 감지
    const isMyBookingRequest = /내.*예약|예약.*내역|예약.*확인|예약.*조회|예약.*보여|내가.*예약|나.*예약/.test(userMessage);
    if (isMyBookingRequest) {
      const db = require('../services/db');
      const userKey = kakaoUserId;
      const [rows] = await db.query(
        'SELECT * FROM bookings WHERE kakao_user_id = ? ORDER BY created_at DESC LIMIT 5',
        [userKey]
      );
      let replyMsg = '';
      if (rows.length === 0) {
        replyMsg = '아직 예약 내역이 없습니다 😊\n새로운 예약을 원하시면 환자분 성함과 나이를 알려주세요!';
      } else {
        replyMsg = '📋 예약 내역입니다!\n\n';
        rows.forEach((b, i) => {
          const status = b.status === 'confirmed' ? '✅ 확정' : b.status === 'pending' ? '⏳ 대기중' : b.status === 'cancelled' ? '❌ 취소' : b.status;
          replyMsg += (i+1) + '. ' + b.date + ' ' + b.time + '\n' +
            '   환자: ' + b.patient_name + ' (' + b.age + '세)\n' +
            '   병원: ' + b.hospital + ' (' + b.region + ')\n' +
            '   서비스: ' + (b.service_type == 1 ? '기사동행 포함' : '기사동행 미포함') + '\n' +
            '   상태: ' + status + '\n\n';
        });
      }
      if (callbackUrl) {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } })
        });
      } else {
        return res.json({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } });
      }
      return;
    }

    const { message, bookingData, showDriverButtons, humanAgentRequest } = await chat(session.history, userMessage, session.booked);
      session.data = mergeData(session.data, bookingData);
      session.history.push({ role: "user", content: userMessage });
      session.history.push({ role: "model", content: message });

      if (!session.booked && isComplete(session.data)) {
        const confirmResponse = await finalizeBooking(session, kakaoUserId);
        return res.json(confirmResponse);
      }
      return res.json(makeTextResponse(message));
    }

    if (callbackUrl) {
      res.json({
        version: "2.0",
        useCallback: true,
        template: {
          outputs: [{ simpleText: { text: "잠시만요 🔍" } }]
        }
      });
      console.log("processAndCallback 호출 직전");
      processAndCallback(kakaoUserId, userMessage, callbackUrl).catch(e => console.error("processAndCallback 오류:", e.message));
    } else {
      // callbackUrl 없을 때 직접 처리
      if (!sessions[kakaoUserId]) {
        sessions[kakaoUserId] = { history: [], data: {}, booked: false };
      }
      const session = sessions[kakaoUserId];
      // 내 예약 조회 요청 감지
    const isMyBookingRequest = /내.*예약|예약.*내역|예약.*확인|예약.*조회|예약.*보여|내가.*예약|나.*예약/.test(userMessage);
    if (isMyBookingRequest) {
      const db = require('../services/db');
      const userKey = kakaoUserId;
      const [rows] = await db.query(
        'SELECT * FROM bookings WHERE kakao_user_id = ? ORDER BY created_at DESC LIMIT 5',
        [userKey]
      );
      let replyMsg = '';
      if (rows.length === 0) {
        replyMsg = '아직 예약 내역이 없습니다 😊\n새로운 예약을 원하시면 환자분 성함과 나이를 알려주세요!';
      } else {
        replyMsg = '📋 예약 내역입니다!\n\n';
        rows.forEach((b, i) => {
          const status = b.status === 'confirmed' ? '✅ 확정' : b.status === 'pending' ? '⏳ 대기중' : b.status === 'cancelled' ? '❌ 취소' : b.status;
          replyMsg += (i+1) + '. ' + b.date + ' ' + b.time + '\n' +
            '   환자: ' + b.patient_name + ' (' + b.age + '세)\n' +
            '   병원: ' + b.hospital + ' (' + b.region + ')\n' +
            '   서비스: ' + (b.service_type == 1 ? '기사동행 포함' : '기사동행 미포함') + '\n' +
            '   상태: ' + status + '\n\n';
        });
      }
      if (callbackUrl) {
        await fetch(callbackUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } })
        });
      } else {
        return res.json({ version: '2.0', template: { outputs: [{ simpleText: { text: replyMsg } }] } });
      }
      return;
    }

    const { message, bookingData, showDriverButtons, humanAgentRequest } = await chat(session.history, userMessage, session.booked);
      session.data = mergeData(session.data, bookingData);
      session.history.push({ role: "user", content: userMessage });
      session.history.push({ role: "model", content: message });
      if (!session.booked && isComplete(session.data)) {
        const confirmResponse = await finalizeBooking(session, kakaoUserId);
        return res.json(confirmResponse);
      }
      return res.json(makeTextResponse(message));
    }

  } catch (err) {
    console.error("Webhook 오류:", err);
    return res.json(makeTextResponse("일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요."));
  }
});

module.exports = router;
