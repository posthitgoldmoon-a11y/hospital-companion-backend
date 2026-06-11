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

async function sendTelegramMessage(chatId, text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("Telegram 발송 실패:", err.message);
  }
}

async function sendManagerNotification(manager, booking) {
  const serviceText = booking.service_type === 1 ? "기사동행 포함" : "기사동행 미포함";
  const acceptUrl = `https://hospital-companion.duckdns.org/manager/accept/${booking.id}`;
  const rejectUrl = `https://hospital-companion.duckdns.org/manager/reject/${booking.id}`;

  const message =
    `🔔 <b>새 예약 콜!</b>\n\n` +
    `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
    `🏥 병원: ${booking.hospital}\n` +
    `📅 일시: ${booking.date} ${booking.time}\n` +
    `🚗 서비스: ${serviceText}\n` +
    `📍 지역: ${booking.region}\n` +
    `⏱ 이용시간: ${booking.duration}시간\n\n` +
    `✅ 수락: ${acceptUrl}\n` +
    `❌ 거절: ${rejectUrl}`;

  console.log(`[매니저 알림] ${manager.name}:\n${message}`);

  // 관리자에게 알림
  if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
    await sendTelegramMessage(
      process.env.TELEGRAM_ADMIN_CHAT_ID,
      `📋 <b>새 예약 접수</b>\n\n` +
      `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
      `🏥 병원: ${booking.hospital}\n` +
      `📅 일시: ${booking.date} ${booking.time}\n` +
      `🚗 서비스: ${serviceText}\n` +
      `📍 지역: ${booking.region}\n` +
      `👩‍⚕️ 배정 매니저: ${manager.name} (${manager.phone})`
    );
  }

  // 매니저에게 알림 (텔레그램 ID 있는 경우)
  if (manager.telegram_id) {
    await sendTelegramMessage(manager.telegram_id, message);
  }

  return true;
}

module.exports = {
  makeTextResponse,
  makeButtonResponse,
  makeBookingConfirmResponse,
  sendManagerNotification,
  sendTelegramMessage,
};
