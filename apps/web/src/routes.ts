import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

const routes = [
  {
    path: "/",
    component: lazy(() => import("@/routes/home")),
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
