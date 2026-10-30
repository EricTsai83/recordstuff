import { describe, expect, it } from "vitest";
import { CLEAN_SECONDS, Governor, pacePolicy, type Pace, type PacePolicy } from "./governor";

const CLEAN = { late: 0, lost: 0, backlog: 1 };
const LATE = { late: 2, lost: 0, backlog: 1 };

function governor(policy: PacePolicy = "governed") {
  const paces: Pace[] = [];
  const logs: string[] = [];
  const governed = new Governor({ policy, changed: (pace) => paces.push(pace), log: (line) => logs.push(line) });
  return { governed, paces, logs };
}

const seconds = (governed: Governor, n: number, sample = CLEAN): void => { for (let i = 0; i < n; i++) governed.sample(sample); };

describe("the governor of versions prepared alongside a recording (plan 100 step 4)", () => {
  it("holds versions from a recording's start until it has had ten clean seconds, careful all the while", () => {
    const { governed, paces } = governor();
    expect(governed.pace).toEqual({ careful: false });
    governed.update({ recording: true });
    expect(governed.pace).toEqual({ held: "a recording's health", careful: true });
    seconds(governed, CLEAN_SECONDS - 1);
    expect(governed.pace.held).toBeDefined();
    governed.sample(CLEAN);
    expect(governed.pace).toEqual({ careful: true });
    expect(paces).toEqual([{ held: "a recording's health", careful: true }, { careful: true }]);
  });

  it("holds them at a late, lost or queued picture, and lets go only after ten clean seconds in a row, so it does not flap", () => {
    const { governed, paces, logs } = governor();
    governed.update({ recording: true });
    seconds(governed, CLEAN_SECONDS);
    for (const bad of [LATE, { late: 0, lost: 1, backlog: 0 }, { late: 0, lost: 0, backlog: 2 }]) {
      governed.sample(bad);
      expect(governed.pace.held, JSON.stringify(bad)).toBe("a recording's health");
      seconds(governed, CLEAN_SECONDS);
      expect(governed.pace.held).toBeUndefined();
    }
    // A bad second in the middle of the clean ones starts the count again.
    governed.sample(LATE);
    seconds(governed, 5);
    governed.sample(LATE);
    seconds(governed, CLEAN_SECONDS - 1);
    expect(governed.pace.held).toBeDefined();
    governed.sample(CLEAN);
    expect(governed.pace.held).toBeUndefined();
    expect(paces.filter((pace) => pace.held)).toHaveLength(5);
    expect(logs.filter((line) => line.includes("lost time ("))).toHaveLength(4);
    governed.update({ recording: false });
    expect(logs.at(-1), "the recording's health, said as it ends").toBe("versions: the recording's health: 5 of 60 s lost time (6 late, 1 lost, at most 2 in the encoder)");
  });

  it("lets go of what a recording held as it ends, whatever its last seconds said, and starts over at the next", () => {
    const { governed } = governor();
    governed.update({ recording: true });
    seconds(governed, 3, LATE);
    governed.update({ recording: false });
    expect(governed.pace).toEqual({ careful: false });
    // Samples after the end change nothing.
    governed.sample(LATE);
    expect(governed.pace).toEqual({ careful: false });
    governed.update({ recording: true });
    seconds(governed, CLEAN_SECONDS - 1);
    expect(governed.pace.held, "the clean seconds of the last recording do not count").toBeDefined();
  });

  it("holds them for a recording's whole length on a Mac whose class has not passed the gate", () => {
    const { governed } = governor("pause");
    governed.update({ recording: true });
    seconds(governed, 60);
    expect(governed.pace).toEqual({ held: "a recording", careful: true });
    governed.update({ recording: false });
    expect(governed.pace).toEqual({ careful: false });
  });

  it("holds them for a Live preview, a save, serious or critical heat and Low Power Mode, while they last", () => {
    const { governed } = governor();
    for (const [condition, held] of [
      [{ preview: true }, "a Live preview"],
      [{ saving: true }, "a recording being saved"],
      [{ thermal: "serious" }, "the system's heat (serious)"],
      [{ thermal: "critical" }, "the system's heat (critical)"],
      [{ lowPower: true }, "Low Power Mode"],
    ] as const) {
      governed.update(condition);
      expect(governed.pace).toEqual({ held, careful: false });
      governed.update({ preview: false, saving: false, thermal: "nominal", lowPower: false });
      expect(governed.pace).toEqual({ careful: false });
    }
    governed.update({ thermal: "fair" });
    expect(governed.pace.held, "fair heat is no reason").toBeUndefined();
  });

  it("governs only the Mac classes that passed the gate", () => {
    expect(pacePolicy("win32", "Apple M1 Pro")).toBe("pause");
    expect(pacePolicy("darwin", undefined)).toBe("pause");
    expect(pacePolicy("darwin", "Some chip nobody measured")).toBe("pause");
  });
});

describe("Low Power Mode as pmset says it", () => {
  it("is on only when pmset says lowpowermode 1", async () => {
    const { lowPowerIn, readLowPower } = await import("./low-power");
    expect(lowPowerIn(" sleep                1\n lowpowermode         1\n hibernatemode        3\n")).toBe(true);
    expect(lowPowerIn(" lowpowermode         0\n")).toBe(false);
    expect(lowPowerIn(" powermode            1\n")).toBe(false);
    expect(lowPowerIn("")).toBe(false);
    expect(await readLowPower("win32")).toBe(false);
  });
});
