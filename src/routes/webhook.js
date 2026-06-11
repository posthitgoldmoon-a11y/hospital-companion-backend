const express = require("express");
const router = express.Router();
const { processCustomerInput, extractSingleInfo } = require("../services/gemini");
const { findAvailableManager } = require("../services/manager-filter");
const { createBooking, assignManager } = require("../models/booking");
const { findOrCreateCustomer } = require("../models/customer");
const { makeTextResponse, makeBookingConfirmResponse, sendManagerNotification } = require("../services/kakao-api");
const bookingQueue = require("../services/queue");

const sessions = {};

const BOOKING_STEPS = [
  { field: "patient_name", question: "환자분 성함이 어떻게 되시나요?" },
  { field: "age", question: "환자분 나이가 어떻게 되시나요?" },
  { field: "hospital", question: "어느 병원으로 가시나요?" },
  { field: "region", question: "지역이 어디세요? (서울 / 경기 / 인천)" },
  { field: "date", question: "방문 날짜가 언제인가요? (예: 2026-06-20)" },
  { field: "time", question: "방문 시간은 언제인가요? (예: 14:00)" },
  { field: "duration", question: "이용 시간은 몇 시간 예정이신가요? (기본 2시간)" },
];

function getNextQuestion(session) {
  for (let i = 0; i < BOOKING_STEPS.length; i++) {
    const step = BOOKING_STEPS[i];
    if (!session.data[step.field]) {
      session.currentFieldIndex = i;
      return step.question;
    }
  }
  return null;
}

async function finalizeBooking(session, kakaoUserId) {
  const customer = await findOrCreateCustomer(kakaoUserId);

  const booking = await createBooking({
    customer_id: customer.id,
    ...session.data,
    service_type: session.serviceType,
    duration: parseInt(session.data.duration) || 2,
  });

  const manager = await findAvailableManager(session.data.region, session.serviceType);

  if (!manager) {
    sessions[kakaoUserId] = { step: "init", data: {}, serviceType: null };
    return makeTextResponse(
      "죄송합니다. 현재 해당 지역에 가능한 매니저가 없습니다.\n잠시 후 다시 시도해주세요."
    );
  }

  await assignManager(booking.id, manager.id);
  await sendManagerNotification(manager, { ...booking, region: session.data.region });

  sessions[kakaoUserId] = { step: "init", data: {}, serviceType: null };
  return makeBookingConfirmResponse(booking, manager);
}

async function handleBookingCollection(session, kakaoUserId, userMessage) {
  const currentStep = BOOKING_STEPS[session.currentFieldIndex];
  const extracted = await extractSingleInfo(userMessage, currentStep.field);

  if (extracted) {
    session.data[currentStep.field] = extracted;
  } else {
    return makeTextResponse(`다시 입력해주세요.\n${currentStep.question}`);
  }

  const nextQuestion = getNextQuestion(session);
  if (!nextQuestion) {
    return await finalizeBooking(session, kakaoUserId);
  }

  return makeTextResponse(nextQuestion);
}

router.post("/", async (req, res) => {
  try {
    const body = req.body;
    const userRequest = body.userRequest;
    const kakaoUserId = userRequest.user.id;
    const userMessage = userRequest.utterance.trim();

    if (!sessions[kakaoUserId]) {
      sessions[kakaoUserId] = { step: "init", data: {}, serviceType: null };
    }
    const session = sessions[kakaoUserId];

    if (session.step === "collecting") {
      const response = await bookingQueue.add(() =>
        handleBookingCollection(session, kakaoUserId, userMessage)
      );
      return res.json(response);
    }

    const geminiResult = await processCustomerInput(userMessage);
    const category = geminiResult.category;

    if (category === "1" || category === "2") {
      session.serviceType = parseInt(category);
      session.step = "collecting";
      session.currentFieldIndex = 0;
      session.data = {};

      const extracted = geminiResult.extracted_info || {};
      Object.keys(extracted).forEach((key) => {
        if (extracted[key]) session.data[key] = extracted[key];
      });

      const nextQuestion = getNextQuestion(session);
      if (!nextQuestion) {
        const response = await finalizeBooking(session, kakaoUserId);
        return res.json(response);
      }

      return res.json(makeTextResponse(
        `${category === "1" ? "🚗 기사동행 포함" : "🚶 기사동행 미포함"} 예약을 시작합니다.\n\n${nextQuestion}`
      ));
    }

    if (category === "3") {
      return res.json(makeTextResponse(
        `안녕하세요! 병원동행 서비스입니다 😊\n\n` +
        `저희 서비스는 병원 방문 시 전문 매니저가 동행해드립니다.\n\n` +
        `📋 요금 안내\n` +
        `• 기본 2시간: 40,000원\n` +
        `• 30분 추가: 10,000원\n\n` +
        `예약을 원하시면 "예약해주세요"라고 말씀해주세요.`
      ));
    }

    return res.json(makeTextResponse(
      "안녕하세요! 병원동행 서비스입니다.\n예약을 원하시면 '예약해주세요'라고 말씀해주세요."
    ));

  } catch (err) {
    console.error("Webhook 오류:", err);
    return res.json(makeTextResponse("일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요."));
  }
});

module.exports = router;
