import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  MAX_TEXT_COMMIT,
  sendRemoteText,
  validRemoteText,
} from "@/libs/domain/remote-control/text";
import {
  REMOTE_TEXT_CARET,
  REMOTE_TEXT_SEED,
  RemoteTextInput,
} from "@/libs/domain/remote-control/text-input";

describe("remote text packets", () => {
  it("bounds UTF-16 packets without splitting surrogate pairs", () => {
    const chunks: string[] = [];
    const value = "中".repeat(63) + "😀".repeat(33);
    expect(
      sendRemoteText(value, {
        text: (v) => {
          chunks.push(v);
          return true;
        },
        key: () => true,
      }),
    ).toBe("sent");
    expect(chunks.join("")).toBe(value);
    expect(chunks.map((v) => v.length)).toEqual([
      63, 64, 2,
    ]);
    expect(chunks.every(validRemoteText)).toBe(true);
  });
  it("sends multiline paste as ordered text, Enter and Tab strokes", () => {
    const events: string[] = [];
    expect(
      sendRemoteText("Hi\r\n世界\t😀\rEnd", {
        text: (v) => {
          events.push(v);
          return true;
        },
        key: (v) => {
          events.push(v);
          return true;
        },
      }),
    ).toBe("sent");
    expect(events).toEqual([
      "Hi",
      "Enter",
      "世界",
      "Tab",
      "😀",
      "Enter",
      "End",
    ]);
  });
  it("rejects malformed or oversized commits before sending any prefix", () => {
    const text = vi.fn(() => true),
      key = vi.fn(() => true);
    for (const value of [
      "",
      "a\u0000b",
      "a\u0085",
      "a\ud800",
      "\udfff",
    ])
      expect(sendRemoteText(value, { text, key })).toBe(
        "invalid",
      );
    expect(
      sendRemoteText("a".repeat(MAX_TEXT_COMMIT + 1), {
        text,
        key,
      }),
    ).toBe("too-long");
    expect(text).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
    for (const value of [
      "",
      "\n",
      "\t",
      "a".repeat(65),
      "\ud800",
    ])
      expect(validRemoteText(value)).toBe(false);
  });
  it("stops at a failed send without replaying later characters", () => {
    const text = vi.fn(() => false),
      key = vi.fn(() => true);
    expect(
      sendRemoteText("prefix\nnext", { text, key }),
    ).toBe("interrupted");
    expect(text).toHaveBeenCalledTimes(1);
    expect(key).not.toHaveBeenCalled();
    text.mockReturnValue(true);
    key.mockReturnValue(false);
    expect(sendRemoteText("\nnext", { text, key })).toBe(
      "interrupted",
    );
    expect(text).toHaveBeenCalledTimes(1);
  });
});

function staged(text: string) {
  return (
    REMOTE_TEXT_SEED.slice(0, REMOTE_TEXT_CARET) +
    text +
    REMOTE_TEXT_SEED.slice(REMOTE_TEXT_CARET)
  );
}
function editor() {
  let value = REMOTE_TEXT_SEED;
  const commit = vi.fn(),
    key = vi.fn();
  const input = new RemoteTextInput({
    read: () => value,
    reset: () => {
      value = REMOTE_TEXT_SEED;
    },
    commit,
    key,
  });
  return {
    input,
    commit,
    key,
    write: (text: string) => {
      value = text;
    },
    value: () => value,
  };
}
describe("soft keyboard edit lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("does not replay local editor history into the remote application", () => {
    const e = editor();
    expect(
      e.input.beforeInput("historyUndo", false, true),
    ).toBe(true);
    e.write(staged("previous input"));
    e.input.input("historyUndo", false);
    expect(e.commit).not.toHaveBeenCalled();
    expect(e.value()).toBe(REMOTE_TEXT_SEED);
  });
  it("forwards normal characters once and keeps a deletable seed", () => {
    const e = editor();
    expect(
      e.input.beforeInput("insertText", false, true),
    ).toBe(false);
    e.write(staged("a"));
    e.input.input("insertText", false);
    e.input.input("insertText", false); // no DOM mutation: never replay InputEvent.data
    expect(e.commit.mock.calls).toEqual([["a"]]);
    for (let i = 0; i < 3; i++)
      expect(
        e.input.beforeInput(
          "deleteContentBackward",
          false,
          true,
        ),
      ).toBe(true);
    expect(e.key.mock.calls).toEqual([
      ["Backspace"],
      ["Backspace"],
      ["Backspace"],
    ]);
    expect(e.value()).toBe(REMOTE_TEXT_SEED);
  });
  it.each([
    "insertFromComposition",
    "insertCompositionText",
    "insertText",
  ])(
    "commits IME once when %s follows compositionend",
    (type) => {
      const e = editor();
      e.input.compositionStart();
      e.write(staged("zhong"));
      e.input.input("insertCompositionText", true);
      expect(e.commit).not.toHaveBeenCalled();
      e.write(staged("中😀"));
      e.input.compositionEnd();
      expect(e.input.beforeInput(type, false, true)).toBe(
        false,
      );
      e.input.input(type, false);
      expect(e.commit).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(e.commit.mock.calls).toEqual([["中😀"]]);
      e.input.input(type, false);
      expect(e.commit).toHaveBeenCalledTimes(1);
    },
  );
  it("handles final input before compositionend, cancellation and successive compositions", () => {
    const e = editor();
    e.input.compositionStart();
    e.write(staged("文"));
    e.input.input("insertText", false);
    e.input.compositionEnd();
    e.input.compositionStart(); // previous commit flushes before new composition
    expect(e.commit.mock.calls).toEqual([["文"]]);
    e.write(REMOTE_TEXT_SEED);
    e.input.compositionEnd();
    vi.runAllTimers();
    expect(e.commit).toHaveBeenCalledTimes(1);
  });
  it("keeps IME deletion local and supports noncancelable deletion and Enter", () => {
    const e = editor();
    e.input.compositionStart();
    expect(
      e.input.beforeInput(
        "deleteContentBackward",
        true,
        false,
      ),
    ).toBe(false);
    e.input.input("deleteContentBackward", true);
    expect(e.key).not.toHaveBeenCalled();
    e.input.reset();
    expect(
      e.input.beforeInput(
        "deleteContentBackward",
        false,
        false,
      ),
    ).toBe(false);
    e.write("");
    e.input.input("deleteContentBackward", false);
    expect(
      e.input.beforeInput("insertLineBreak", false, true),
    ).toBe(true);
    e.write("\n");
    e.input.input("insertParagraph", false);
    expect(e.key.mock.calls).toEqual([
      ["Backspace"],
      ["Enter"],
      ["Enter"],
    ]);
    expect(e.commit).not.toHaveBeenCalled();
  });
  it("forwards paste once and never replays unfinished text after blur or reconnect", () => {
    const e = editor();
    e.input.paste("剪贴板😀\n");
    e.input.input("insertFromPaste", false);
    expect(e.commit.mock.calls).toEqual([["剪贴板😀\n"]]);
    e.input.compositionStart();
    e.write(staged("未提交"));
    e.input.compositionEnd();
    e.input.reset();
    vi.runAllTimers();
    expect(e.commit).toHaveBeenCalledTimes(1);
    expect(e.value()).toBe(REMOTE_TEXT_SEED);
  });
});

it("forwards repeated selection-only IME navigation in both directions without sending guards", () => {
  const e = editor();
  for (const position of [0, 2, 2, 0]) {
    e.input.selectionChanged(position, position);
    e.input.selectionChanged(
      REMOTE_TEXT_CARET,
      REMOTE_TEXT_CARET,
    );
  }
  expect(e.key.mock.calls).toEqual([
    ["ArrowLeft"],
    ["ArrowRight"],
    ["ArrowRight"],
    ["ArrowLeft"],
  ]);
  expect(e.commit).not.toHaveBeenCalled();
  expect(e.value()).toBe(REMOTE_TEXT_SEED);
});
it("keeps composition, text mutations and range selections local", () => {
  const e = editor();
  e.input.selectionChanged(0, 2);
  e.write(staged("中文"));
  e.input.selectionChanged(0, 0);
  e.input.compositionStart();
  e.write(REMOTE_TEXT_SEED);
  e.input.selectionChanged(2, 2);
  expect(e.key).not.toHaveBeenCalled();
  e.input.reset();
});
it("strips surviving guards when an IME replaces the local surrounding text", () => {
  const e = editor();
  for (const value of [
    staged("中"),
    "\u200b文",
    "字\u200b",
    "😀",
  ]) {
    e.write(value);
    e.input.input("insertText", false);
  }
  expect(e.commit.mock.calls).toEqual([
    ["中"],
    ["文"],
    ["字"],
    ["😀"],
  ]);
});
