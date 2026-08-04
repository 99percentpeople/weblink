import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getDialogBodyClassName,
  getDialogContentClassName,
} from "@/components/ui/dialog-styles";

describe("dialog layout classes", () => {
  it("constrains the dialog and delegates scrolling to its body", () => {
    const contentClasses =
      getDialogContentClassName("flex flex-col").split(" ");
    const bodyClasses = getDialogBodyClassName().split(" ");

    expect(contentClasses).toContain(
      "max-h-[calc(100dvh-2rem)]",
    );
    expect(contentClasses).toContain("overflow-hidden");
    expect(bodyClasses).toContain("min-h-0");
    expect(bodyClasses).toContain("overflow-y-auto");
    expect(bodyClasses).toContain("overscroll-contain");
  });
});

const describeWithDom =
  process.env.VITEST === "true" ? describe : describe.skip;

describeWithDom("BaseDialog layout", () => {
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(
      () => {},
    );
  });

  afterEach(async () => {
    const { cleanup } =
      await import("@solidjs/testing-library");
    cleanup();
    vi.restoreAllMocks();
  });

  it("scrolls only the body while keeping the title and footer fixed", async () => {
    const [{ render }, { BaseDialog }] = await Promise.all([
      import("@solidjs/testing-library"),
      import("@/components/dialogs/dialog"),
    ]);

    render(() => (
      <BaseDialog
        isOpen={true}
        title={
          <span data-testid="dialog-title">Title</span>
        }
        description={<span>Description</span>}
        content={
          <div data-testid="dialog-content">Content</div>
        }
        confirm={
          <button data-testid="dialog-footer">
            Confirm
          </button>
        }
      />
    ));

    const body = document.querySelector<HTMLElement>(
      '[data-slot="dialog-body"]',
    );
    const title = document.querySelector<HTMLElement>(
      '[data-testid="dialog-title"]',
    );
    const content = document.querySelector<HTMLElement>(
      '[data-testid="dialog-content"]',
    );
    const footer = document.querySelector<HTMLElement>(
      '[data-testid="dialog-footer"]',
    );
    const dialog = body?.parentElement;

    expect(body).not.toBeNull();
    expect(title).not.toBeNull();
    expect(content).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(dialog).not.toBeNull();

    expect(body?.classList.contains("min-h-0")).toBe(true);
    expect(
      body?.classList.contains("overflow-y-auto"),
    ).toBe(true);
    expect(
      dialog?.classList.contains("overflow-hidden"),
    ).toBe(true);
    expect(
      dialog?.classList.contains(
        "max-h-[calc(100dvh-2rem)]",
      ),
    ).toBe(true);

    expect(body?.contains(content!)).toBe(true);
    expect(body?.contains(title!)).toBe(false);
    expect(body?.contains(footer!)).toBe(false);
  });
});
