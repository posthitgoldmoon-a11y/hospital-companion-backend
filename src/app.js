const express = require("express");
const path = require("path");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));
app.use('/images', express.static(path.join(__dirname, '../이미지')));
app.use('/images', express.static(path.join(__dirname, '../public/images')));
app.use('/img', express.static(path.join(__dirname, '../')));

app.use("/webhook", require("./routes/webhook"));
app.use("/chat-demo", require("./routes/chatdemo"));
app.use("/booking", require("./routes/booking"));
app.use("/manager", require("./routes/manager"));

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Hospital Companion Backend" });
});

// 텔레그램 봇 시작
// require("./services/telegram-bot"); // 돈워리 전용 - 부킷메디 불필요

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});

module.exports = app;
