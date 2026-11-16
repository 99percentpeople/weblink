import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import { localeNavigationTarget } from "./locale-navigation";
import { useDisclosureNavigation } from "./disclosure-navigation";
import "./style.css";

export default {
  extends: DefaultTheme,
  setup() {
    useDisclosureNavigation();
  },
  enhanceApp({ router, siteData }) {
    if (typeof window === "undefined") return;
    router.onBeforeRouteChange = (to) => {
      const target = localeNavigationTarget(
        to,
        window.location.href,
        siteData.value.base,
      );
      if (target !== to) {
        void router.go(target);
        return false;
      }
    };
  },
} satisfies Theme;
