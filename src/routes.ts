import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

const LegacyHome = lazy(
  () => import("@/routes/legacy-home"),
);
const routes = [
  {
    path: "/",
    component: lazy(() => import("@/routes/home")),
  },
  {
    path: [
      "/home",
      "/video",
      "/chat",
      "/file",
      "/setting",
      "/conversation/:id",
      "/chat/conversation/:id",
      "/client/:id/chat",
      "/chat/client/:id/chat",
    ],
    component: LegacyHome,
  },
  {
    path: "/client/:id/sync",
    component: lazy(
      () => import("@/routes/client/[id]/sync"),
    ),
  },
  {
    path: "/share",
    component: lazy(() => import("@/routes/share")),
  },
  {
    path: "*path",
    component: lazy(() => import("@/routes/[...404]")),
  },
] satisfies RouteDefinition[];

export default routes;
