import { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

const routes = [
  {
    path: "/",
    component: lazy(() => import("@/routes/index")),
    children: [
      {
        path: "/",
        component: lazy(() => import("@/routes/client")),
      },
      {
        path: "client/:id",
        component: lazy(
          () => import("@/routes/client/[id]"),
        ),
      },
    ],
  },
  {
    path: "/video",
    component: lazy(() => import("@/routes/video")),
  },
  {
    path: "/file",
    component: lazy(() => import("@/routes/file")),
  },
  {
    path: "/setting",
    component: lazy(() => import("@/routes/setting")),
  },
  {
    path: "*path",
    component: lazy(() => import("@/routes/[...404]")),
  },
] satisfies RouteDefinition[];

export default routes;
