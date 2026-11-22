import assert from "node:assert/strict";
import test from "node:test";

import { slicePoints, volumeWeekStart } from "./chart-series";
import {
  bucketBars,
  closedDaysAfterSeed,
  contiguousRanges,
  DAY_MS,
  lastSeedDate,
  pullComplete,
  resolveVenueVolume,
  seedPoints,
  utcDayStart,
  volumeNote,
  type DayPull,
} from "./volume-history";

const NOV8 = Date.parse("2026-11-08T00:00:00.000Z");
const NOV9 = Date.parse("2026-11-09T00:00:00.000Z");
const NOV10 = Date.parse("2026-11-10T00:00:00.000Z");
const NOV11 = Date.parse("2026-11-11T00:00:00.000Z");
const NOV12 = Date.parse("2026-11-12T00:00:00.000Z");
const NOV21 = Date.parse("2026-11-21T00:00:00.000Z");
const NOV22 = Date.parse("2026-11-22T00:00:00.000Z");
const NOV23 = Date.parse("2026-11-23T00:00:00.000Z");

const TXFLOW_AFTER_NOV8: Array<[string, number]> = [
  ["2026-11-09", 153554481],
  ["2026-11-10", 210247525],
  ["2026-11-11", 170045466],
  ["2026-11-12", 165924919],
  ["2026-11-13", 208936819],
  ["2026-11-14", 254622067],
  ["2026-11-15", 295879244],
  ["2026-11-16", 221077918],
  ["2026-11-17", 270263732],
  ["2026-11-18", 223770051],
  ["2026-11-19", 264507974],
  ["2026-11-20", 613106127],
  ["2026-11-21", 452577262],
];

function pull(byDay: Array<[number, number]>, failed = 0, total = 50, error: string | null = null): DayPull {
  return { byDay: new Map(byDay), failed, total, error };
}

test("DefiLlama seed keeps RISEx through 2026-11-08 and extends Txflow through 2026-11-21", () => {
  const rise = seedPoints("risex");
  const tx = seedPoints("txflow");
  assert.equal(rise.length, 222);
  assert.equal(rise[0]?.t, Date.parse("2026-04-01T00:00:00.000Z"));
  assert.equal(rise.at(-1)?.t, NOV8);
  assert.equal(rise.at(-1)?.v, 108423034);
  assert.equal(
    rise.reduce((sum, point) => sum + point.v, 0),
    15813554827,
  );
  assert.equal(
    rise.slice(-7).reduce((sum, point) => sum + point.v, 0),
    1065659688,
  );
  assert.equal(tx.length, 241);
  assert.equal(tx[0]?.t, Date.parse("2026-03-26T00:00:00.000Z"));
  assert.equal(tx.at(-1)?.t, NOV21);
  assert.equal(tx.at(-1)?.v, 452577262);
  assert.equal(
    tx.reduce((sum, point) => sum + point.v, 0),
    16616622042,
  );
  assert.equal(
    tx.slice(-7).reduce((sum, point) => sum + point.v, 0),
    2341182308,
  );
  const txByDay = new Map(tx.map((point) => [point.t, point.v]));
  assert.equal(txByDay.get(NOV8), 146319006);
  for (const [day, volume] of TXFLOW_AFTER_NOV8) {
    assert.equal(txByDay.get(Date.parse(`${day}T00:00:00.000Z`)), volume);
  }
  for (const points of [rise, tx]) {
    for (let index = 1; index < points.length; index += 1) {
      assert.equal(points[index]!.t - points[index - 1]!.t, DAY_MS);
    }
  }
  assert.equal(lastSeedDate(rise), "2026-11-08");
  assert.equal(lastSeedDate(tx), "2026-11-21");
  assert.match(volumeNote(lastSeedDate(rise)), /2026-11-08/);
  assert.match(volumeNote(lastSeedDate(tx)), /2026-11-21/);
  assert.notEqual(volumeNote(lastSeedDate(rise)), volumeNote(lastSeedDate(tx)));
});

test("on the extract day the seed close is kept and only the open day is fetched", async () => {
  const now = Date.parse("2026-11-09T06:19:31.000Z");
  const calls: Array<[number, number]> = [];
  const writes: Array<{ dayStartMs: number; volume: number }> = [];
  const seed = seedPoints("risex");
  const resolved = await resolveVenueVolume({
    seed,
    now,
    readFrozen: async () => null,
    writeFrozen: async (entries) => {
      writes.push(...entries);
      return true;
    },
    pull: async (from, to) => {
      calls.push([from, to]);
      return pull([[NOV9, 222]]);
    },
  });
  assert.deepEqual(calls, [[NOV9, NOV10]]);
  assert.deepEqual(writes, []);
  assert.equal(resolved.points.find((point) => point.t === NOV8)?.v, 108423034);
  assert.equal(resolved.points.find((point) => point.t === NOV9)?.v, 222);
  assert.equal(resolved.settled, true);
  const week = slicePoints(resolved.points, volumeWeekStart(now));
  assert.equal(week.length, 7);
  assert.equal(week[0]?.t, Date.parse("2026-11-03T00:00:00.000Z"));
  assert.equal(week.at(-1)?.v, 222);
  assert.equal(closedDaysAfterSeed(seed, now).length, 0);
});

test("a closed day after this venue's seed is stored and the open day is not", async () => {
  const now = Date.parse("2026-11-23T00:10:00.000Z");
  const writes: Array<{ dayStartMs: number; volume: number }> = [];
  const resolved = await resolveVenueVolume({
    seed: seedPoints("txflow"),
    now,
    readFrozen: async () => null,
    writeFrozen: async (entries) => {
      writes.push(...entries);
      return true;
    },
    pull: async () => pull([
      [NOV21, 1],
      [NOV22, 80],
      [NOV23, 5],
    ]),
  });
  assert.deepEqual(writes, [{ dayStartMs: NOV22, volume: 80 }]);
  assert.equal(resolved.points.find((point) => point.t === NOV21)?.v, 452577262);
  assert.equal(resolved.points.find((point) => point.t === NOV22)?.v, 80);
  assert.equal(resolved.points.find((point) => point.t === NOV23)?.v, 5);
  assert.equal(resolved.settled, true);
});

test("a frozen value cannot replace a seed day, and each venue ends on its own date", async () => {
  const now = Date.parse("2026-11-22T12:00:00.000Z");
  const txReads: number[] = [];
  const tx = await resolveVenueVolume({
    seed: seedPoints("txflow"),
    now,
    readFrozen: async (day) => {
      txReads.push(day);
      return 1;
    },
    writeFrozen: async () => true,
    pull: async () => pull([[NOV22, 9]]),
  });
  assert.deepEqual(txReads, []);
  assert.deepEqual(closedDaysAfterSeed(seedPoints("txflow"), now), []);
  for (const [day, volume] of TXFLOW_AFTER_NOV8) {
    assert.equal(tx.points.find((point) => point.t === Date.parse(`${day}T00:00:00.000Z`))?.v, volume);
  }
  assert.equal(tx.points.find((point) => point.t === NOV22)?.v, 9);
  assert.match(tx.note, /2026-11-21/);

  const riseReads: number[] = [];
  const riseWrites: Array<{ dayStartMs: number; volume: number }> = [];
  const rise = await resolveVenueVolume({
    seed: seedPoints("risex"),
    now,
    readFrozen: async (day) => {
      riseReads.push(day);
      return day === NOV9 ? 70 : 71;
    },
    writeFrozen: async (entries) => {
      riseWrites.push(...entries);
      return true;
    },
    pull: async () => pull([[NOV22, 3]]),
  });
  const riseClosed = closedDaysAfterSeed(seedPoints("risex"), now);
  assert.deepEqual(riseReads, riseClosed);
  assert.equal(riseClosed[0], NOV9);
  assert.equal(riseClosed.at(-1), NOV21);
  assert.equal(riseClosed.length, 13);
  assert.deepEqual(riseWrites, []);
  assert.equal(rise.points.find((point) => point.t === NOV8)?.v, 108423034);
  assert.equal(rise.points.find((point) => point.t === NOV9)?.v, 70);
  assert.equal(rise.points.find((point) => point.t === NOV21)?.v, 71);
  assert.equal(rise.points.find((point) => point.t === NOV22)?.v, 3);
  assert.match(rise.note, /2026-11-08/);
  assert.equal(rise.note.includes("2026-11-21"), false);
});

test("a stored close is reused and a partial close is shown but not stored", async () => {
  const now = Date.parse("2026-11-12T03:00:00.000Z");
  const writes: Array<{ dayStartMs: number; volume: number }> = [];
  const calls: Array<[number, number]> = [];
  const resolved = await resolveVenueVolume({
    seed: [{ t: NOV8, v: 10 }],
    now,
    readFrozen: async (day) => (day === NOV9 ? 70 : null),
    writeFrozen: async (entries) => {
      writes.push(...entries);
      return true;
    },
    pull: async (from, to) => {
      calls.push([from, to]);
      return pull(
        [
          [NOV10, 4],
          [NOV11, 6],
          [NOV12, 1],
        ],
        3,
        50,
      );
    },
  });
  assert.deepEqual(calls, [[NOV10, NOV13()]]);
  assert.deepEqual(writes, []);
  assert.equal(resolved.points.find((point) => point.t === NOV9)?.v, 70);
  assert.equal(resolved.points.find((point) => point.t === NOV10)?.v, 4);
  assert.equal(resolved.points.find((point) => point.t === NOV11)?.v, 6);
  assert.equal(resolved.settled, false);
  assert.match(resolved.extras.join(" "), /faltan 3 de 50/);
  assert.equal(pullComplete(pull([], 0, 0, "sin mercados")), false);
});

test("a failed venue keeps the seed and does not store the open day", async () => {
  const now = Date.parse("2026-11-09T12:00:00.000Z");
  const writes: unknown[] = [];
  const resolved = await resolveVenueVolume({
    seed: seedPoints("risex"),
    now,
    readFrozen: async () => null,
    writeFrozen: async (entries) => {
      writes.push(entries);
      return true;
    },
    pull: async () => pull([], 0, 0, "timeout"),
  });
  assert.equal(writes.length, 0);
  assert.equal(resolved.points.at(-1)?.t, NOV8);
  assert.equal(resolved.points.at(-1)?.v, 108423034);
  assert.match(resolved.extras.join(" "), /no respondió \(timeout\)/);
  assert.equal(resolved.settled, false);
});

test("candle buckets stay inside the requested window", () => {
  const bars = bucketBars(
    [
      { t: NOV8, v: 9 },
      { t: NOV9 + 3_600_000, v: 4 },
      { t: NOV10, v: 1 },
    ],
    NOV9,
    NOV10,
  );
  assert.deepEqual([...bars.entries()], [[NOV9, 4]]);
});

test("several missing closed days share one range and stop before the open day", () => {
  const days = closedDaysAfterSeed([{ t: NOV8, v: 1 }], Date.parse("2026-11-12T00:00:00.000Z"));
  assert.deepEqual(days, [NOV9, NOV10, NOV11]);
  assert.deepEqual(contiguousRanges(days), [{ from: NOV9, to: NOV12, days }]);
  assert.equal(utcDayStart(Date.parse("2026-11-12T23:59:00.000Z")), NOV12);
});

function NOV13(): number {
  return NOV12 + DAY_MS;
}
