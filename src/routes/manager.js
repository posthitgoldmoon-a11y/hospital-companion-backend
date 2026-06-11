const express = require("express");
const router = express.Router();
const { getAllManagers, getManagerById, updateManagerStatus } = require("../models/manager");
const { getBookingById, assignManager } = require("../models/booking");

router.get("/", async (req, res) => {
  try {
    const managers = await getAllManagers();
    res.json(managers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/accept/:bookingId", async (req, res) => {
  try {
    const booking = await getBookingById(req.params.bookingId);
    if (!booking) return res.status(404).json({ error: "예약을 찾을 수 없습니다." });
    res.json({ message: "예약 수락 완료", booking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    await updateManagerStatus(req.params.id, status);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
