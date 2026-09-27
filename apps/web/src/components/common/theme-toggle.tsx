import { useColorMode } from "@kobalte/core";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import {
  IconComputer,
  IconDarkMode,
  IconLightMode,
} from "../icons";

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
          class="size-6 scale-100 rotate-0 transition-all dark:scale-0
            dark:-rotate-90"
        />
        <IconDarkMode
          class="absolute size-6 scale-0 rotate-90 transition-all
            dark:scale-100 dark:rotate-0"
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
