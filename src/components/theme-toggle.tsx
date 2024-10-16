import { useColorMode } from "@kobalte/core";

import IconComputer from "@material-design-icons/svg/outlined/computer.svg?component-solid";
import IconLightMode from "@material-design-icons/svg/outlined/light_mode.svg?component-solid";
import IconDarkMode from "@material-design-icons/svg/outlined/dark_mode.svg?component-solid";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export function ThemeToggle() {
  const { setColorMode } = useColorMode();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={Button<"button">}
        variant="ghost"
        size="sm"
        class="w-9 px-0"
      >
        <IconLightMode
          class="size-6 rotate-0 scale-100 transition-all dark:-rotate-90
            dark:scale-0"
        />
        <IconDarkMode
          class="absolute size-6 rotate-90 scale-0 transition-all
            dark:rotate-0 dark:scale-100"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          class="gap-2"
          onSelect={() => setColorMode("light")}
        >
          <IconLightMode class="size-4" />
          <span>{t("common.theme_toggle.light")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          class="gap-2"
          onSelect={() => setColorMode("dark")}
        >
          <IconDarkMode class="size-4" />
          <span>{t("common.theme_toggle.dark")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          class="gap-2"
          onSelect={() => setColorMode("system")}
        >
          <IconComputer class="size-4" />
          <span>{t("common.theme_toggle.system")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
