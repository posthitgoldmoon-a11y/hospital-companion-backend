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
  });

  const manager = await findAvailableManager(session.data.region, parseInt(session.data.service_type), session.data.date, session.data.time);

  if (!manager) {
    sessions[kakaoUserId] = { history: [], data: {}, booked: false };
    return makeTextResponse("죄송합니다. 현재 해당 지역에 가능한 매니저가 없습니다.\n잠시 후 다시 시도해주세요.");
  }

  await assignManager(booking.id, manager.id);
  sendManagerNotification(manager, { ...booking, region: session.data.region });
  session.data = {};
  session.booked = true;
  return makeBookingConfirmResponse(booking, manager);
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
    if (!sessions[kakaoUserId]) {
      sessions[kakaoUserId] = { history: [], data: {}, booked: false };
    }
    const session = sessions[kakaoUserId];

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
    const { message, bookingData } = await chat(session.history, userMessage, session.booked);
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
      await fetch(callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeTextResponse(message))
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

      const { message, bookingData } = await chat(session.history, userMessage, session.booked);
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
      const { message, bookingData } = await chat(session.history, userMessage, session.booked);
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
