const express = require("express");
const router = express.Router();
const { getBookingById, updateBookingStatus } = require("../models/booking");

router.get("/:id", async (req, res) => {
  try {
    const booking = await getBookingById(req.params.id);
    if (!booking) return res.status(404).json({ error: "예약을 찾을 수 없습니다." });
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    await updateBookingStatus(req.params.id, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
