import assert from "node:assert/strict";
import { test } from "node:test";
import { minutesFromClock, scheduledMinutes } from "./clock.js";

test("valid clock times, including midnight and late evening", () => {
  for (const [clock, expected] of [["00:00", 0], ["08:00", 480], ["09:30", 570], ["17:15", 1035], ["23:59", 1439]] as const) {
    assert.equal(minutesFromClock(clock), expected);
  }
  assert.equal(minutesFromClock(" 08:00 "), 480);
});

test("invalid clock times do not pass", () => {
  for (const value of ["24:00", "12:60", "8:00", "", "99:99", "08:00x", "08:00:00"]) {
    assert.equal(minutesFromClock(value), null, value);
  }
});

test("scheduled durations support the schedule's clock range", () => {
  assert.equal(scheduledMinutes("08:00-16:30"), 510);
  assert.equal(scheduledMinutes("08:00 – 12:00"), 240);
  for (const value of ["08:00", "invalid", "16:00-08:00", "08:00-08:00", "08:00-09:00-10:00"]) {
    assert.equal(scheduledMinutes(value), 0);
  }
});
