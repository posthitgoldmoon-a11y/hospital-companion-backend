const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

app.use("/webhook", require("./routes/webhook"));
app.use("/booking", require("./routes/booking"));
app.use("/manager", require("./routes/manager"));

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "Hospital Companion Backend" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});

module.exports = app;
