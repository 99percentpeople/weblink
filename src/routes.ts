import { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

const routes = [
  {
    path: "/",
    component: lazy(() => import("@/routes/index")),
    children: [
      {
        path: "conversation/:id",
        component: lazy(
          () => import("@/routes/conversation"),
        ),
      },
      {
        path: "/",
        component: lazy(() => import("@/routes/client")),
      },
      {
        path: "client/:id/chat",
        component: lazy(
          () => import("@/routes/client/[id]/chat"),
        ),
      },
      {
        path: "client/:id/sync",
        component: lazy(
          () => import("@/routes/client/[id]/sync"),
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
    path: "/share",
    component: lazy(() => import("@/routes/share")),
  },
  {
    path: "*path",
    component: lazy(() => import("@/routes/[...404]")),
  },
] satisfies RouteDefinition[];

export default routes;
