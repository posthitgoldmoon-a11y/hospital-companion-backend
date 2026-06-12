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
    `🚗 서비스: ${booking.service_type === 1 ? "운전대행+동행" : "동행만"}\n` +
    `👩‍⚕️ 매니저: ${manager.name}\n\n` +
    `💰 예상 요금: ${(() => {
      const duration = booking.duration;
      const isDriver = booking.service_type == 1;
      const isDialysis = booking.service_type == 3;
      
      let base = 0;
      if (isDialysis) {
        base = 80000;
        if (duration > 3) base += Math.ceil((duration - 3) * 2) * 15000;
        if (isDriver) base += duration * 20000;
      } else {
        base = 60000;
        if (duration > 2) base += Math.ceil((duration - 2) * 2) * 15000;
        if (isDriver) base += 20000;
      }
      return base.toLocaleString();
    })()}원 (${booking.duration}시간 기준)\n\n` +
    `추가 문의사항 있으시면 알려주세요. 성심껏 답변 드리겠습니다.`;
  return makeTextResponse(text);
}

async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: chatId, text, parse_mode: "HTML", ...options }
    );
  } catch (err) {
    console.error("Telegram 발송 실패:", err.message);
  }
}

async function sendManagerNotification(manager, booking) {
  const serviceText = booking.service_type === 1 ? "운전대행+동행" : "동행만";

  const specialReqText = booking.special_requests ? `\n⚠️ 고객 요청사항: ${booking.special_requests}` : '';
  const message =
    `🔔 <b>새 예약 콜!</b>\n\n` +
    `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
    `🏥 병원: ${booking.hospital}\n` +
    `📅 일시: ${booking.date} ${booking.time}\n` +
    `🚗 서비스: ${serviceText}\n` +
    `📍 지역: ${booking.region}\n` +
    `⏱ 이용시간: ${booking.duration}시간${specialReqText}\n\n` +
    `예약번호: ${booking.id}`;

  console.log(`[매니저 알림] ${manager.name}:\n${message}`);

  // 관리자 알림
  const adminIds = (process.env.TELEGRAM_ADMIN_CHAT_IDS || process.env.TELEGRAM_ADMIN_CHAT_ID || '').split(',').filter(id => id.trim());
  for (const adminId of adminIds) {
    await sendTelegramMessage(
      adminId.trim(),
      `📋 <b>새 예약 접수</b>\n\n` +
      `👤 환자: ${booking.patient_name} (${booking.age}세)\n` +
      `🏥 병원: ${booking.hospital}\n` +
      `📅 일시: ${booking.date} ${booking.time}\n` +
      `🚗 서비스: ${serviceText}\n` +
      `📍 지역: ${booking.region}\n` +
      `👩‍⚕️ 배정 매니저: ${manager.name} (${manager.phone})` +
      (booking.special_requests ? `\n⚠️ 고객 요청사항: ${booking.special_requests}` : ''),
      {
        reply_markup: JSON.stringify({
          inline_keyboard: [
            [
              { text: "✅ 수락", callback_data: `accept_${booking.id}` },
              { text: "❌ 거절", callback_data: `reject_${booking.id}` }
            ]
          ]
        })
      }
    );
  }

  // 매니저 알림 (수락/거절 버튼 포함)
  if (manager.telegram_id) {
    await sendTelegramMessage(manager.telegram_id, message, {
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            { text: "✅ 수락", callback_data: `accept_${booking.id}` },
            { text: "❌ 거절", callback_data: `reject_${booking.id}` }
          ]
        ]
      })
    });
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
