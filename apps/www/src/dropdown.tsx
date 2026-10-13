import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { createSignal, Index, Show } from "solid-js";
import { render } from "solid-js/web";

interface DropdownOption {
  value: string;
  label: string;
  icon?: string;
  lang?: string;
}

interface DropdownState {
  value: string;
  label: string;
  icon: string;
  options: readonly DropdownOption[];
}

interface Dropdown {
  update(state: DropdownState): void;
}

function Icon(props: { name: string }) {
  return (
    <svg class="icon" aria-hidden="true">
      <use href={`./icons.svg#${props.name}`} />
    </svg>
  );
}

// Mount a small Solid island; Kobalte owns menu interaction and focus.
export function setupDropdown(
  container: HTMLElement,
  signal: AbortSignal,
  config: {
    id: "language" | "theme";
    onChange(value: string): void;
  },
): Dropdown {
  const [state, setState] = createSignal<DropdownState>();
  const dispose = render(
    () => (
      <Show when={state()}>
        {(current) => (
          <DropdownMenu
            modal={false}
            placement="bottom-end"
            gutter={4}
            overflowPadding={16}
            onOpenChange={(open) => {
              if (!open) return;
              const navigation =
                document.querySelector<HTMLDetailsElement>(
                  ".mobile-menu",
                );
              if (navigation) navigation.open = false;
            }}
          >
            <DropdownMenu.Trigger
              id={`${config.id}-trigger`}
              class="menu-trigger"
              aria-label={current().label}
              title={current().label}
            >
              <Icon name={current().icon} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                id={`${config.id}-options`}
                class="menu-options"
              >
                <DropdownMenu.RadioGroup
                  value={current().value}
                  onChange={config.onChange}
                >
                  <Index each={current().options}>
                    {(option) => (
                      <DropdownMenu.RadioItem
                        as="button"
                        type="button"
                        class="menu-option"
                        closeOnSelect
                        value={option().value}
                        textValue={option().label}
                        data-locale-value={
                          config.id === "language"
                            ? option().value
                            : undefined
                        }
                        data-theme-value={
                          config.id === "theme"
                            ? option().value
                            : undefined
                        }
                      >
                        <Show when={option().icon}>
                          {(icon) => <Icon name={icon()} />}
                        </Show>
                        <DropdownMenu.ItemLabel
                          as="span"
                          lang={option().lang}
                        >
                          {option().label}
                        </DropdownMenu.ItemLabel>
                        <DropdownMenu.ItemIndicator
                          as="span"
                          class="menu-option-check"
                          forceMount
                        >
                          <Icon name="check" />
                        </DropdownMenu.ItemIndicator>
                      </DropdownMenu.RadioItem>
                    )}
                  </Index>
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        )}
      </Show>
    ),
    container,
  );
  signal.addEventListener(
    "abort",
    () => {
      dispose();
      container.hidden = true;
    },
    { once: true },
  );
  return {
    update(value) {
      if (signal.aborted) return;
      setState(value);
      container.hidden = false;
    },
  };
}
