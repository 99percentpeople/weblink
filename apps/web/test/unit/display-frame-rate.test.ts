import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DisplayFrameRateCalibration,
  estimateDisplayFrameRate,
  observeDisplayFrameRate,
} from "@/libs/domain/display-frame-rate";

function calibration() {
  const value = new DisplayFrameRateCalibration();
  const rates: number[] = [];
  let now = 0;
  return {
    value,
    rates,
    sample(
      fps: number,
      windows = 4,
      display = "display-a",
    ) {
      for (let n = 0; n < windows; n++) {
        const intervals = Array<number>(120).fill(
          1000 / fps,
        );
        now += 120_000 / fps;
        const changed = value.sample(
          intervals,
          now,
          display,
        );
        if (changed) rates.push(changed);
      }
    },
  };
}

describe("display frame-rate calibration", () => {
  it("recognizes a recurring 120 Hz cadence mixed with missed callbacks", () => {
    expect(
      estimateDisplayFrameRate(
        Array.from(
          { length: 120 },
          (_, n) => 1000 / (n % 4 === 0 ? 120 : 60),
        ),
      ),
    ).toBe(120);
    expect(
      estimateDisplayFrameRate(
        Array.from(
          { length: 120 },
          (_, n) => (1000 / 120) * (1 + (n % 3)),
        ),
      ),
    ).toBe(120);
  });

  it("does not infer a faster display from a single short interval", () => {
    const intervals = Array<number>(120).fill(1000 / 60);
    intervals[0] = 1000 / 120;
    expect(estimateDisplayFrameRate(intervals)).toBe(60);
  });

  it("collects higher-rate evidence across intermittent slower windows", () => {
    const f = calibration();
    f.sample(60);
    for (let n = 0; n < 5; n++) {
      f.sample(120, 1);
      f.sample(60, 1);
    }
    expect(f.rates).toEqual([60, 120]);
  });

  it("expires isolated higher-rate observations instead of combining unrelated bursts", () => {
    const f = calibration();
    f.sample(60);
    for (let n = 0; n < 5; n++) {
      f.sample(120, 1);
      f.sample(60, 4);
    }
    expect(f.rates).toEqual([60]);
  });
  it("holds 120 Hz through repeated sustained 60/120 scheduling cycles", () => {
    const f = calibration();
    f.sample(120);
    expect(f.rates).toEqual([120]);
    for (let cycle = 0; cycle < 5; cycle++) {
      f.sample(60, 30);
      f.sample(120, 30);
    }
    expect(f.rates).toEqual([120]);
  });

  it("can upgrade an initial 60 Hz calibration once faster cadence is confirmed", () => {
    const f = calibration();
    f.sample(60);
    f.sample(120, 1);
    f.sample(60);
    expect(f.rates).toEqual([60]);
    f.sample(120);
    f.sample(60, 60);
    expect(f.rates).toEqual([60, 120]);
  });

  it("requires elapsed evidence as well as multiple windows on fast displays", () => {
    const f = calibration();
    f.sample(240, 3);
    expect(f.rates).toEqual([]);
    f.sample(240, 4);
    expect(f.rates).toEqual([240]);
  });

  it("recalibrates to a lower rate when the display context changes", () => {
    const f = calibration();
    f.sample(120);
    f.sample(60, 2, "display-b");
    expect(f.rates).toEqual([120]);
    f.sample(60, 2, "display-b");
    expect(f.rates).toEqual([120, 60]);
  });

  it("forgets interrupted evidence without forgetting the confirmed cadence", () => {
    const f = calibration();
    f.sample(120);
    f.sample(165, 2);
    f.value.resetEvidence();
    f.sample(165, 1);
    f.sample(60, 20);
    expect(f.rates).toEqual([120]);
  });
});

describe("display frame-rate observer", () => {
  const aborts: AbortController[] = [];
  afterEach(() => {
    aborts.splice(0).forEach((abort) => abort.abort());
    vi.unstubAllGlobals();
  });

  function observer() {
    class Document extends EventTarget {
      visibilityState = "visible";
      defaultView = {
        screen: {
          width: 2560,
          height: 1440,
          availLeft: 0,
          availTop: 0,
        },
        devicePixelRatio: 1,
      };
    }
    const doc = new Document();
    const callbacks = new Map<
      number,
      FrameRequestCallback
    >();
    let next = 0;
    let now = 0;
    vi.stubGlobal("document", doc);
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback) => {
        callbacks.set(++next, cb);
        return next;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", (id: number) =>
      callbacks.delete(id),
    );
    const abort = new AbortController();
    aborts.push(abort);
    const changed = vi.fn();
    observeDisplayFrameRate(changed, abort.signal);
    return {
      abort,
      changed,
      callbacks,
      doc,
      frames(fps: number, count: number) {
        for (let frame = 0; frame < count; frame++) {
          now += 1000 / fps;
          const batch = [...callbacks.values()];
          callbacks.clear();
          batch.forEach((cb) => cb(now));
        }
      },
      visibility(value: string) {
        doc.visibilityState = value;
        doc.dispatchEvent(new Event("visibilitychange"));
      },
    };
  }

  it("retains calibration across backgrounding and slow foreground callbacks, and cleans up", () => {
    const f = observer();
    f.frames(120, 600);
    expect(f.changed.mock.calls).toEqual([[120]]);
    f.visibility("hidden");
    f.frames(1, 30);
    f.visibility("visible");
    f.frames(60, 1200);
    f.frames(120, 1200);
    expect(f.changed.mock.calls).toEqual([[120]]);
    f.abort.abort();
    expect(f.callbacks.size).toBe(0);
    f.visibility("hidden");
    expect(f.callbacks.size).toBe(0);
  });

  it("discards a batch spanning displays and then confirms the new monitor's cadence", () => {
    const f = observer();
    f.frames(120, 600);
    f.doc.defaultView.screen.availLeft = 2560;
    f.frames(60, 120);
    expect(f.changed.mock.calls).toEqual([[120]]);
    f.frames(60, 600);
    expect(f.changed.mock.calls).toEqual([[120], [60]]);
  });

  it("does not start work for an already aborted owner", () => {
    const f = observer();
    f.abort.abort();
    observeDisplayFrameRate(f.changed, f.abort.signal);
    expect(f.callbacks.size).toBe(0);
  });

  it("upgrades a live observer from 60 to 120 despite frequent missed callbacks", () => {
    const f = observer();
    f.frames(60, 600);
    expect(f.changed.mock.calls).toEqual([[60]]);
    for (let frame = 0; frame < 720; frame++) {
      f.frames(frame % 4 === 0 ? 120 : 60, 1);
    }
    expect(f.changed.mock.calls).toEqual([[60], [120]]);
    f.frames(60, 1200);
    expect(f.changed.mock.calls).toEqual([[60], [120]]);
  });
});
