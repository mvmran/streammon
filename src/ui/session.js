// Session recording: 1-second CSV rows kept in a bounded buffer, optionally streamed to a
// file on disk as they arrive (File System Access API, Chrome/Edge).

import { csvHeader, csvRow } from '../dsp/report.js';

const MAX_ROWS = 12 * 3600; // 12 hours of 1-second rows (~4 MB of text)

export class SessionRecorder {
  constructor() {
    this.rows = [];
    this.dropped = 0;
    this.writer = null;
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
    if (this.writer) this.write(line);
  }

  csv() {
    return csvHeader() + this.rows.join('');
  }

  static get diskSupported() {
    return typeof window.showSaveFilePicker === 'function';
  }

  // Starts streaming rows to a user-chosen file; existing rows are written first.
  async startDisk(suggestedName) {
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
    });
    this.writer = await handle.createWritable();
    this.fileName = handle.name;
    this.write(csvHeader() + this.rows.join(''));
  }

  write(text) {
    const w = this.writer;
    this.queue = this.queue.then(() => w.write(text)).catch((e) => {
      // Disk full, file removed, permission revoked: stop recording and say so, rather than
      // carry on as if the file were still being written.
      if (this.writer !== w) return;
      this.writer = null;
      Promise.resolve().then(() => w.abort()).catch(() => {});
      if (this.onDiskError) this.onDiskError(e, this.fileName);
    });
  }

  async stopDisk() {
    if (!this.writer) return;
    const w = this.writer;
    this.writer = null;
    await this.queue;
    await w.close();
  }
}
