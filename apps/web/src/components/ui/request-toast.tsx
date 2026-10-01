import {
  createRoot,
  createSignal,
  For,
  Show,
  type JSX,
} from "solid-js";
import { toast } from "solid-sonner";
import { ChevronDown } from "lucide-solid";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

export interface RequestToastOptions {
  id: string;
  title(): string;
  description(): JSX.Element;
  acceptLabel(): string;
  declineLabel(): string;
  isCurrent(): boolean;
  respond(accepted: boolean): Promise<void>;
  choices?: { label(): string; respond(): Promise<void> }[];
  choicesLabel?(): string;
  errorMessage(): string;
  onError?(error: unknown): void;
}

/** In-app presenter shared by requests. The owner controls expiration and disposal. */
export function showRequestToast(
  options: RequestToastOptions,
): { dismiss(): void } {
  return createRoot((dispose) => {
    const [busy, setBusy] = createSignal(false);
    const [failed, setFailed] = createSignal(false);
    let closed = false;
    const dismiss = () => {
      if (closed) return;
      closed = true;
      toast.dismiss(options.id);
      dispose();
    };
    const respond = async (action: () => Promise<void>) => {
      if (closed || busy()) return;
      if (!options.isCurrent()) {
        dismiss();
        return;
      }
      setBusy(true);
      setFailed(false);
      try {
        await action();
        dismiss();
      } catch (error) {
        if (closed) return;
        if (!options.isCurrent()) {
          dismiss();
          return;
        }
        options.onError?.(error);
        setFailed(true);
      } finally {
        if (!closed) setBusy(false);
      }
    };
    toast(options.title, {
      id: options.id,
      duration: Infinity,
      // Requests need an explicit answer; ordinary toasts retain their usual swipe behavior.
      dismissible: false,
      closeButton: false,
      description: () => (
        <>
          {options.description()}
          <Show when={failed()}>
            <span
              role="alert"
              class="text-destructive block"
            >
              {options.errorMessage()}
            </span>
          </Show>
        </>
      ),
      cancel: (
        <button
          type="button"
          data-button
          data-cancel
          disabled={busy()}
          onClick={() =>
            void respond(() => options.respond(false))
          }
        >
          {options.declineLabel()}
        </button>
      ),
      action: (
        <div data-request-actions>
          <button
            type="button"
            data-button
            data-action
            disabled={busy()}
            onClick={() =>
              void respond(() => options.respond(true))
            }
          >
            {options.acceptLabel()}
          </button>
          <Show when={options.choices?.length}>
            <DropdownMenu
              placement="bottom-end"
              modal={false}
            >
              <DropdownMenuTrigger
                data-button
                data-action
                data-request-menu
                disabled={busy()}
                aria-label={options.choicesLabel?.()}
              >
                <ChevronDown class="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="z-[1000000000]">
                <For each={options.choices}>
                  {(choice) => (
                    <DropdownMenuItem
                      disabled={busy()}
                      onSelect={() =>
                        void respond(choice.respond)
                      }
                    >
                      {choice.label()}
                    </DropdownMenuItem>
                  )}
                </For>
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
        </div>
      ),
    });
    return { dismiss };
  });
}
