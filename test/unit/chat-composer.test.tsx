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

const service = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendFile: vi.fn(),
  preview: vi.fn(),
  folder: vi.fn(),
  drop: vi.fn(),
  error: vi.fn(),
  mobile: false,
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    sendText: service.sendText,
    sendFile: service.sendFile,
  }),
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: { options: { enableClipboard: false } },
}));
vi.mock("@/libs/hooks/create-mobile", () => ({
  createIsMobile: () => () => service.mobile,
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
  service.mobile = false;
  service.sendText.mockReset();
  service.sendText.mockResolvedValue(undefined);
  service.sendFile.mockReset();
  service.sendFile.mockResolvedValue(undefined);
  service.preview.mockReset();
  service.preview.mockResolvedValue({ result: true });
});
afterEach(cleanup);

describe("shared chat composer adapters", () => {
  it("routes file, media, phone capture and zipped folders to the private peer without submitting the text draft", async () => {
    service.mobile = true;
    const { container } = render(() => (
      <ChatBar client={alice} />
    ));
    const textbox = screen.getByRole(
      "textbox",
    ) as HTMLTextAreaElement;
    fireEvent.input(textbox, {
      target: { value: "a draft for later" },
    });
    for (const kind of ["file", "media", "capture"]) {
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
        "Connection failed",
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
