import { Button } from "@/components/ui/button";
import { A, RouteSectionProps } from "@solidjs/router";

export default function NotFound(props: RouteSectionProps) {
  return (
    <main
      class="mx-auto flex min-h-[calc(100%_-_3rem)] flex-col items-center
        justify-center gap-8 p-4"
    >
      <h1 class="max-6-xs text-6xl font-thin uppercase">
        404 Not Found
      </h1>
      <p>/{props.params.path}</p>
      {/* <p>
        Visit{" "}
        <a
          href="https://solidjs.com"
          target="_blank"
          class="text-sky-600 hover:underline"
        >
          solidjs.com
        </a>{" "}
        to learn how to build Solid apps.
      </p> */}
      <p class="my-4">
        <Button as={A} href="/" variant="outline" class="">
          Home
        </Button>
      </p>
    </main>
  );
}
