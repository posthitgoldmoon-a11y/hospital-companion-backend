const axios = require("axios");
require("dotenv").config();

function makeTextResponse(text) {
  return {
    version: "2.0",
    template: { outputs: [{ simpleText: { text } }] },
  };
}

function makeButtonResponse(text, buttons) {
  return {
    version: "2.0",
    template: {
      outputs: [{
        basicCard: {
          title: text,
          buttons: buttons.map((btn) => ({
            action: btn.action || "message",
            label: btn.label,
            messageText: btn.messageText || btn.label,
          })),
        },
      }],
    },
  };
}

function makeBookingConfirmResponse(booking, manager) {
  const text =
    `✅ 예약이 확정되었습니다!\n\n` +
    `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
    `🏥 병원: ${booking.hospital}\n` +
    `📅 일시: ${booking.date} ${booking.time}\n` +
    `🚗 서비스: ${booking.service_type === 1 ? "기사동행 포함" : "기사동행 미포함"}\n` +
    `👩‍⚕️ 매니저: ${manager.name}\n\n` +
    `💰 예상 요금: ${booking.duration * 20000}원 (${booking.duration}시간 기준)\n\n` +
    `문의사항은 채널로 메시지 보내주세요.`;
  return makeTextResponse(text);
}

async function sendManagerNotification(manager, booking) {
  const message =
    `🔔 새 예약 배정!\n\n` +
    `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
    `🏥 병원: ${booking.hospital}\n` +
    `📅 일시: ${booking.date} ${booking.time}\n` +
    `🚗 서비스: ${booking.service_type === 1 ? "기사동행 포함" : "기사동행 미포함"}\n` +
    `📍 지역: ${booking.region}\n\n` +
    `수락: http://158.180.83.78:3000/manager/accept/${booking.id}`;

  console.log(`[매니저 알림] ${manager.name}:\n${message}`);

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    await sendTelegramMessage(message);
  }
  return true;
}

async function sendTelegramMessage(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: process.env.TELEGRAM_CHAT_ID, text }
    );
  } catch (err) {
    console.error("Telegram 발송 실패:", err.message);
  }
}

module.exports = {
  makeTextResponse,
  makeButtonResponse,
  makeBookingConfirmResponse,
  sendManagerNotification,
};
