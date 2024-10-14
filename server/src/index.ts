import koa from "koa";
import Router from "koa-router";
import websocket from "koa-websocket";

const app = websocket(new koa());

const router = new Router();

router.all("/", (ctx) => {});

app.ws.use(router.routes);

app.listen(3000, () => {});
