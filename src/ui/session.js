// Session recording: 1-second CSV rows kept in a bounded buffer, optionally streamed to a
// file on disk as they arrive (File System Access API, Chrome/Edge).

import { csvHeader, csvRow } from '../dsp/report.js';

const MAX_ROWS = 12 * 3600; // 12 hours of 1-second rows (~22 MB of text with the band and spectrum columns)

export class SessionRecorder {
  static COMMIT_MS = 15000; // how often rows recorded to disk reach the file

  constructor() {
    this.rows = [];
    this.dropped = 0;
    this.handle = null; // file being recorded to (FileSystemFileHandle)
    this.pending = ''; // rows not yet committed to it
    this.timer = null;
    this.queue = Promise.resolve();
    this.fileName = null;
    this.onDiskError = null; // (error, fileName) when writing to disk fails and stops
  }

  clear() {
    this.rows = [];
    this.dropped = 0;
  }

  get count() {
    return this.rows.length;
  }

  add(row) {
    const line = csvRow(row);
    this.rows.push(line);
    if (this.rows.length > MAX_ROWS) {
      this.rows.shift();
      this.dropped++;
    }
    if (this.handle) this.pending += line;
  }

  csv() {
    return csvHeader() + this.rows.join('');
  }

  static get diskSupported() {
    return typeof window.showSaveFilePicker === 'function';
  }

  get recording() {
    return !!this.handle;
  }

  // Starts streaming rows to a user-chosen file; existing rows are written first.
  async startDisk(suggestedName) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
    });
    await this.attach(handle);
  }

  // Chrome only puts what a writable stream wrote into the file when the stream is closed
  // (until then it sits in a swap file that a crash or reload throws away). So rows are
  // committed every COMMIT_MS by opening, appending and closing; at most that much is lost.
  async attach(handle) {
    const w = await handle.createWritable(); // empties the file
    await w.write(csvHeader() + this.rows.join(''));
    await w.close();
    this.handle = handle;
    this.fileName = handle.name;
    this.pending = '';
    this.timer = setInterval(() => this.commit(), SessionRecorder.COMMIT_MS);
  }

  commit() {
    const handle = this.handle;
    this.queue = this.queue
      .then(async () => {
        if (!this.pending || this.handle !== handle) return;
        const text = this.pending;
        this.pending = '';
        const size = (await handle.getFile()).size;
        const w = await handle.createWritable({ keepExistingData: true });
        try {
          await w.seek(size);
          await w.write(text);
          await w.close();
        } catch (e) {
          await Promise.resolve().then(() => w.abort()).catch(() => {});
          throw e;
        }
      })
      .catch((e) => {
        // Disk full, file removed, permission revoked: stop recording and say so, rather than
        // carry on as if the file were still being written.
        if (this.handle !== handle) return;
        this.detach();
        if (this.onDiskError) this.onDiskError(e, this.fileName);
      });
    return this.queue;
  }

  detach() {
    clearInterval(this.timer);
    this.handle = null;
  }

  async stopDisk() {
    if (!this.handle) return;
    await this.commit();
    this.detach();
  }
}
