// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { ChatBar } from "@/routes/client/[id]/components/chat-bar";
import { Show } from "solid-js";
import { setAppState } from "@/libs/state/app-state";

const service = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendFile: vi.fn(),
  preview: vi.fn(),
  folder: vi.fn(),
  drop: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    sendText: service.sendText,
    sendFile: service.sendFile,
  }),
}));
vi.mock("@/libs/state/app-state", async () => {
  const { createStore } = await import("solid-js/store");
  const [appState, setAppState] = createStore({
    options: { enableClipboard: false },
    session: { clientViewData: {} },
  });
  return { appState, setAppState };
});
vi.mock("@/components/files/file-picker-dialog", () => ({
  default: (props: {
    open: boolean;
    onSelect(ids: string[]): void;
  }) => (
    <Show when={props.open}>
      <div role="dialog" aria-label="file picker">
        <button
          onClick={() => props.onSelect(["stored-file"])}
        >
          Select file
        </button>
      </div>
    </Show>
  ),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/dialogs/preview-dialog", () => ({
  createSendItemPreviewDialog: () => ({
    open: service.preview,
  }),
}));
vi.mock("@/libs/utils/process-file", () => ({
  handleSelectFolder: service.folder,
  handleDropItems: service.drop,
}));
vi.mock("solid-sonner", () => ({
  toast: {
    error: service.error,
    loading: vi.fn(() => "processing"),
    dismiss: vi.fn(),
  },
}));
vi.mock("@/components/icons", () => ({
  IconAttachFile: () => null,
  IconCamera: () => null,
  IconFolder: () => null,
  IconImage: () => null,
  IconSend: () => null,
}));

const alice = {
  clientId: "alice",
  name: "Alice",
  avatar: null,
};
beforeEach(() => {
  vi.clearAllMocks();
  service.sendText.mockReset();
  service.sendText.mockResolvedValue(undefined);
  service.sendFile.mockReset();
  service.sendFile.mockResolvedValue(undefined);
  service.preview.mockReset();
  service.preview.mockResolvedValue({ result: true });
  for (const clientId of ["alice", "bob"]) {
    setAppState("session", "clientViewData", clientId, {
      clientId,
      name: clientId,
      avatar: null,
      createdAt: 1,
      onlineStatus: "online",
      messageChannel: true,
    });
  }
});
afterEach(cleanup);

describe("shared chat composer adapters", () => {
  it("retains the private draft while disconnected, blocks every send entry and enables them again after reconnection", async () => {
    const { container } = render(() => (
      <ChatBar client={alice} />
    ));
    const textbox = screen.getByRole(
      "textbox",
    ) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "keep this draft" },
    });
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "onlineStatus",
      "offline",
    );
    expect(textbox.disabled).toBe(true);
    expect(textbox.value).toBe("keep this draft");
    for (const input of container.querySelectorAll<HTMLInputElement>(
      'input[type="file"]',
    )) {
      expect(input.disabled).toBe(true);
      fireEvent.change(input, {
        target: {
          files: [new File(["data"], "offline.txt")],
        },
      });
    }
    expect(
      (
        screen.getByRole("button", {
          name: "file_library.choose",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "common.action.send",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.paste(textbox, {
      clipboardData: { items: [{ kind: "file" }] },
    });
    fireEvent.submit(textbox.form!);
    fireEvent.keyDown(textbox, {
      key: "Enter",
      ctrlKey: true,
    });
    expect(service.sendText).not.toHaveBeenCalled();
    expect(service.sendFile).not.toHaveBeenCalled();
    expect(service.drop).not.toHaveBeenCalled();
    expect(textbox.value).toBe("keep this draft");
    setAppState("session", "clientViewData", "alice", {
      onlineStatus: "reconnecting",
      messageChannel: false,
    });
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "onlineStatus",
      "online",
    );
    expect(textbox.disabled).toBe(true);
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "messageChannel",
      true,
    );
    expect(textbox.disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
    expect(textbox.value).toBe("keep this draft");
    expect(service.sendText).not.toHaveBeenCalled();
    fireEvent.submit(textbox.form!);
    await waitFor(() => expect(textbox.value).toBe(""));
    expect(service.sendText).toHaveBeenCalledWith(
      "keep this draft",
      "alice",
    );
  });

  it("closes a library picker on disconnect without clearing the draft or reopening on reconnect", async () => {
    render(() => <ChatBar client={alice} />);
    const textbox = screen.getByRole(
      "textbox",
    ) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "library draft" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "file_library.choose",
      }),
    );
    await screen.findByRole("dialog", {
      name: "file picker",
    });
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "messageChannel",
      false,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "messageChannel",
      true,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(textbox.value).toBe("library draft");
    expect(service.sendFile).not.toHaveBeenCalled();
  });

  it("cancels pending attachment preparation on disconnect and never sends it after reconnection", async () => {
    let finish!: (file: File) => void;
    let signal!: AbortSignal;
    service.folder.mockImplementationOnce(
      (_files: FileList, abortSignal: AbortSignal) => {
        signal = abortSignal;
        return new Promise<File>((resolve) => {
          finish = resolve;
        });
      },
    );
    const { container } = render(() => (
      <ChatBar client={alice} />
    ));
    const input = container.querySelector<HTMLInputElement>(
      'input[data-attachment="folder"]',
    )!;
    fireEvent.change(input, {
      target: { files: [new File(["data"], "file.txt")] },
    });
    expect(signal.aborted).toBe(false);
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "messageChannel",
      false,
    );
    expect(signal.aborted).toBe(true);
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "messageChannel",
      true,
    );
    finish(new File(["zip"], "folder.zip"));
    await waitFor(() => expect(input.disabled).toBe(false));
    expect(service.sendFile).not.toHaveBeenCalled();
    expect(service.error).not.toHaveBeenCalled();
  });

  it("routes file, media and zipped folders to the private peer without submitting the text draft", async () => {
    const { container } = render(() => (
      <ChatBar client={alice} />
    ));
    const textbox = screen.getByRole(
      "textbox",
    ) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "a draft for later" },
    });
    for (const kind of ["file", "media"]) {
      const input =
        container.querySelector<HTMLInputElement>(
          `input[data-attachment="${kind}"]`,
        )!;
      const file = new File(
        [new Uint8Array([0, 255, 42])],
        `${kind}.bin`,
        { type: "application/octet-stream" },
      );
      fireEvent.change(input, {
        target: { files: [file] },
      });
      await waitFor(() =>
        expect(service.sendFile).toHaveBeenCalledWith(
          file,
          "alice",
        ),
      );
      await waitFor(() =>
        expect(input.disabled).toBe(false),
      );
      expect(textbox.value).toBe("a draft for later");
    }
    const zipped = new File(["compressed"], "folder.zip", {
      type: "application/zip",
    });
    service.folder.mockResolvedValue(zipped);
    const folderFile = new File(["nested"], "nested.bin");
    Object.defineProperty(
      folderFile,
      "webkitRelativePath",
      { value: "folder/nested.bin" },
    );
    fireEvent.change(
      container.querySelector(
        'input[data-attachment="folder"]',
      )!,
      { target: { files: [folderFile] } },
    );
    await waitFor(() =>
      expect(service.sendFile).toHaveBeenCalledWith(
        zipped,
        "alice",
      ),
    );
    expect(service.folder).toHaveBeenCalledOnce();
    expect(service.sendText).not.toHaveBeenCalled();
    expect(textbox.value).toBe("a draft for later");
  });

  it("keeps pasted-file previews and sends only confirmed files to the private peer", async () => {
    render(() => <ChatBar client={alice} />);
    const textbox = screen.getByRole(
      "textbox",
    ) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "do not send this draft" },
    });
    const file = new File(["image"], "image.png", {
      type: "image/png",
    });
    service.drop.mockResolvedValue([file]);
    service.preview.mockResolvedValueOnce({
      result: false,
    });
    const clipboardData = {
      items: [{ kind: "file", getAsFile: () => file }],
    };
    fireEvent.paste(textbox, { clipboardData });
    await waitFor(() =>
      expect(service.preview).toHaveBeenCalledWith(
        file,
        "Alice",
      ),
    );
    await waitFor(() =>
      expect(
        textbox.closest("form")?.getAttribute("aria-busy"),
      ).toBe("false"),
    );
    expect(service.sendFile).not.toHaveBeenCalled();
    fireEvent.paste(textbox, { clipboardData });
    await waitFor(() =>
      expect(service.sendFile).toHaveBeenCalledWith(
        file,
        "alice",
      ),
    );
    expect(service.sendText).not.toHaveBeenCalled();
    expect(textbox.value).toBe("do not send this draft");
  });

  it("keeps private keyboard shortcuts and retains failed or newly edited drafts during asynchronous sends", async () => {
    let complete!: () => void;
    service.sendText.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render(() => <ChatBar client={alice} />);
    const textbox = screen.getByRole(
      "textbox",
    ) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "  first draft  " },
    });
    fireEvent.keyDown(textbox, { key: "Enter" });
    fireEvent.keyDown(textbox, {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    expect(service.sendText).not.toHaveBeenCalled();
    fireEvent.keyDown(textbox, {
      key: "Enter",
      ctrlKey: true,
    });
    expect(service.sendText).toHaveBeenCalledWith(
      "first draft",
      "alice",
    );
    fireEvent.keyDown(textbox, {
      key: "Enter",
      shiftKey: true,
    });
    expect(service.sendText).toHaveBeenCalledOnce();
    fireEvent.input(textbox, {
      target: { value: "new draft while sending" },
    });
    complete();
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "common.action.send",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(textbox.value).toBe("new draft while sending");
    service.sendText.mockRejectedValueOnce(
      new Error("Connection failed"),
    );
    fireEvent.keyDown(textbox, {
      key: "Enter",
      shiftKey: true,
    });
    await waitFor(() =>
      expect(service.error).toHaveBeenCalledWith(
        "errors.connection_failed",
      ),
    );
    expect(textbox.value).toBe("new draft while sending");
  });

  it("submits only the selected composer when two private conversations are mounted", async () => {
    render(() => (
      <>
        <ChatBar
          client={alice}
          data-testid="alice-composer"
        />
        <ChatBar
          client={{
            clientId: "bob",
            name: "Bob",
            avatar: null,
          }}
          data-testid="bob-composer"
        />
      </>
    ));
    const aliceComposer = screen.getByTestId(
      "alice-composer",
    );
    const bobComposer = screen.getByTestId("bob-composer");
    const aliceText = within(aliceComposer).getByRole(
      "textbox",
    ) as HTMLTextAreaElement;
    fireEvent.input(aliceText, {
      target: { value: "Alice draft" },
    });
    fireEvent.input(
      within(bobComposer).getByRole("textbox"),
      { target: { value: "Bob message" } },
    );
    fireEvent.click(
      within(bobComposer).getByRole("button", {
        name: "common.action.send",
      }),
    );
    await waitFor(() =>
      expect(service.sendText).toHaveBeenCalledWith(
        "Bob message",
        "bob",
      ),
    );
    expect(service.sendText).toHaveBeenCalledOnce();
    expect(aliceText.value).toBe("Alice draft");
  });
});
