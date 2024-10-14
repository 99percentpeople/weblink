import { APIEvent } from "@solidjs/start/server";

export async function GET(event: APIEvent) {
  const search = new URL(event.request.url).searchParams;

  return new Response(JSON.stringify(search), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}
