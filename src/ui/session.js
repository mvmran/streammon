// Session recording: 1-second CSV rows kept in a bounded buffer, optionally streamed to a
// file on disk as they arrive (File System Access API, Chrome/Edge).

import { csvHeader, csvRow } from '../dsp/report.js';
import { encodePan } from './pan-codec.js';

const ENCODE_TIMEOUT_MS = 5000; // a pan map not compressed by then is left out of its row
const MAX_ROWS = 12 * 3600; // 12 hours of 1-second rows (up to ~36 MB of text with the encoded chart columns)

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
    this.later = Promise.resolve(); // live rows waiting for their pan map (addLive), in order
    this.generation = 0; // bumped by clear(): rows finished after it belong to the old session
    this.added = 0; // rows ever added (attach() uses it to find rows added while it wrote)
  }

  clear() {
    this.rows = [];
    this.dropped = 0;
    this.generation++;
  }

  // A live second with its pan map grid (or null): the map is compressed into row.panCode
  // (async), then the row is added, in order with the rows before it, unless the session was
  // cleared meanwhile. A failed or slow compression (ENCODE_TIMEOUT_MS) leaves that cell
  // empty rather than hold up the rows after it, and Stop and Export, which wait for them.
  addLive(row, panGrid) {
    const generation = this.generation;
    const encoded = encodePan(panGrid).then((code) => (row.panCode = code));
    this.later = this.later
      .then(() => {
        let timer;
        const timeout = new Promise((resolve) => (timer = setTimeout(resolve, ENCODE_TIMEOUT_MS)));
        return Promise.race([encoded, timeout]).finally(() => clearTimeout(timer));
      })
      .catch(() => {})
      .then(() => {
        if (this.generation === generation) this.add(row);
      });
    return this.later;
  }

  get count() {
    return this.rows.length;
  }

  add(row) {
    const line = csvRow(row);
    this.rows.push(line);
    this.added++;
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
    // What is written, and how many rows that is, taken together before anything waits.
    const text = csvHeader() + this.rows.join('');
    const written = this.added;
    const w = await handle.createWritable(); // empties the file
    await w.write(text);
    await w.close();
    this.handle = handle;
    this.fileName = handle.name;
    // Rows added while it wrote (live rows finish at any moment) go in the next commit.
    const since = Math.min(this.rows.length, this.added - written);
    this.pending = since > 0 ? this.rows.slice(-since).join('') : '';
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
    await this.later; // the last rows, still being finished
    if (!this.handle) return; // a failed write stopped the recording meanwhile (and said so)
    await this.commit();
    this.detach();
  }
}
