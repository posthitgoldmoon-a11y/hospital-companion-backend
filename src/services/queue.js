class BookingQueue {
  constructor(concurrency = 100) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this._run();
    });
  }

  _run() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { task, resolve, reject } = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(() => task())
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this.running--;
          this._run();
        });
    }
  }

  get status() {
    return { running: this.running, queued: this.queue.length };
  }
}

const bookingQueue = new BookingQueue(100);
module.exports = bookingQueue;
