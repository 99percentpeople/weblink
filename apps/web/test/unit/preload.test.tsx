// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import {
  createContext,
  createSignal,
  Suspense,
  useContext,
} from "solid-js";
import { preload } from "@/libs/utils/preload";

afterEach(cleanup);

it("shares one request and renders a preloaded component immediately without mounting it during warmup", async () => {
  const context = createContext("missing");
  const mounted = vi.fn();
  const fallbackMounted = vi.fn();
  const Content = (props: { name: string }) => {
    mounted();
    const value = useContext(context);
    return (
      <p>
        {value}: {props.name}
      </p>
    );
  };
  const Fallback = () => {
    fallbackMounted();
    return <p>Loading</p>;
  };
  let finish!: (module: {
    default: typeof Content;
  }) => void;
  const loader = vi.fn(
    () =>
      new Promise<{ default: typeof Content }>(
        (resolve) => {
          finish = resolve;
        },
      ),
  );
  const ContentWithPreload = preload(loader);
  expect(loader).not.toHaveBeenCalled();
  const first = ContentWithPreload.preload();
  expect(ContentWithPreload.preload()).toBe(first);
  await waitFor(() =>
    expect(loader).toHaveBeenCalledOnce(),
  );
  finish({ default: Content });
  await first;
  expect(mounted).not.toHaveBeenCalled();
  const [name, setName] = createSignal("Alice");
  render(() => (
    <context.Provider value="dialog">
      <Suspense fallback={<Fallback />}>
        <ContentWithPreload name={name()} />
      </Suspense>
    </context.Provider>
  ));
  expect(
    screen.getByText("dialog: Alice"),
  ).toBeInTheDocument();
  expect(fallbackMounted).not.toHaveBeenCalled();
  setName("Bob");
  expect(
    screen.getByText("dialog: Bob"),
  ).toBeInTheDocument();
  expect(loader).toHaveBeenCalledOnce();
});

it("shares a pending render request with preload and keeps the normal Suspense fallback", async () => {
  const Content = () => <p>Ready</p>;
  let finish!: (module: {
    default: typeof Content;
  }) => void;
  const loader = vi.fn(
    () =>
      new Promise<{ default: typeof Content }>(
        (resolve) => {
          finish = resolve;
        },
      ),
  );
  const ContentWithPreload = preload(loader);
  render(() => (
    <Suspense fallback={<p>Loading</p>}>
      <ContentWithPreload />
    </Suspense>
  ));
  expect(screen.getByText("Loading")).toBeInTheDocument();
  const warming = ContentWithPreload.preload();
  await waitFor(() =>
    expect(loader).toHaveBeenCalledOnce(),
  );
  finish({ default: Content });
  await warming;
  expect(
    await screen.findByText("Ready"),
  ).toBeInTheDocument();
  expect(loader).toHaveBeenCalledOnce();
});

it.each(["reject", "throw"])(
  "lets rendering retry after a speculative loader %s",
  async (failure) => {
    const module = { default: () => <p>Recovered</p> };
    const error = new Error("Offline");
    const loader = vi
      .fn<() => Promise<typeof module>>()
      .mockImplementationOnce(() => {
        if (failure === "throw") throw error;
        return Promise.reject(error);
      })
      .mockResolvedValue(module);
    const ContentWithPreload = preload(loader);
    await expect(ContentWithPreload.preload()).rejects.toBe(
      error,
    );
    render(() => (
      <Suspense fallback={<p>Loading</p>}>
        <ContentWithPreload />
      </Suspense>
    ));
    expect(
      await screen.findByText("Recovered"),
    ).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
  },
);

it("retries failed preloads and reuses the successful result", async () => {
  const module = { default: () => <p>Recovered</p> };
  const loader = vi
    .fn()
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValue(module);
  const ContentWithPreload = preload(loader);
  await expect(
    ContentWithPreload.preload(),
  ).rejects.toThrow("Offline");
  const retried = ContentWithPreload.preload();
  expect(await retried).toBe(module);
  expect(ContentWithPreload.preload()).toBe(retried);
  render(() => (
    <Suspense fallback={<p>Loading</p>}>
      <ContentWithPreload />
    </Suspense>
  ));
  expect(screen.getByText("Recovered")).toBeInTheDocument();
  expect(loader).toHaveBeenCalledTimes(2);
});
