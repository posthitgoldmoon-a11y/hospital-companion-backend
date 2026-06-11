const express = require("express");
const router = express.Router();

router.post("/", (req, res) => {
  res.json({ version: "2.0", template: { outputs: [{ simpleText: { text: "테스트 중입니다." } }] } });
});

module.exports = router;
