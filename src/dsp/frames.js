// Seconds of audio between two analyzer frames, from their audio-clock times (s), for the
// display averages. The first frame, or time going backwards, counts as one 100 ms frame;
// a long gap is capped at a minute (any average has fully caught up by then).
export function frameStep(prevT, t) {
  return prevT === null || !(t > prevT) ? 0.1 : Math.min(t - prevT, 60);
}
