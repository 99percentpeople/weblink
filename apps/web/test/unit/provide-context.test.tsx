// @vitest-environment jsdom
import {
  createComponent,
  createContext,
  createEffect,
  createSignal,
  onCleanup,
  useContext,
} from "solid-js";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { provideContext } from "@/libs/state/provide-context";
import { createMeetingMediaController } from "@/libs/application/meeting-media-service";

afterEach(cleanup);

it("preserves service and control owners when local media changes", () => {
  const [stream, setStream] =
    createSignal<MediaStream | null>(null);
  const mediaCreated = vi.fn();
  const controlReleased = vi.fn();
  const mediaDisposed = vi.fn();
  const Parent = createContext("parent");
  const Media =
    createContext<
      ReturnType<typeof createMeetingMediaController>
    >();
  const View = () => {
    expect(useContext(Parent)).toBe("application");
    const media = useContext(Media)!;
    createEffect(media.sync);
    onCleanup(controlReleased);
    return (
      <output>
        {media.microphoneOn() ? "microphone" : "silent"}
      </output>
    );
  };
  const view = render(() =>
    provideContext(Parent, "application", () => {
      // Like createMeetingMedia, initialization reads the current stream to
      // select capture devices. That read must not own the provider lifetime.
      const media = createMeetingMediaController({
        stream,
        replace: setStream,
        clear: () => setStream(null),
        getUserMedia: vi.fn(),
      });
      mediaCreated();
      onCleanup(() => {
        media.dispose();
        mediaDisposed();
      });
      return provideContext(Media, media, () =>
        createComponent(View, {}),
      );
    }),
  );
  const track = Object.assign(new EventTarget(), {
    kind: "audio",
    readyState: "live",
    enabled: true,
    getSettings: () => ({ deviceId: "microphone" }),
  }) as MediaStreamTrack;
  const local = Object.assign(new EventTarget(), {
    getTracks: () => [track],
    getVideoTracks: () => [],
  }) as unknown as MediaStream;
  const output = view.container.querySelector("output");
  expect(output?.textContent).toBe("silent");
  for (let i = 0; i < 2; i++) {
    setStream(local);
    expect(
      view.container.querySelector("output")?.textContent,
    ).toBe("microphone");
    expect(controlReleased).not.toHaveBeenCalled();
    setStream(null);
    expect(
      view.container.querySelector("output")?.textContent,
    ).toBe("silent");
    expect(controlReleased).not.toHaveBeenCalled();
  }
  expect(view.container.querySelector("output")).toBe(
    output,
  );
  expect(mediaCreated).toHaveBeenCalledOnce();
  expect(mediaDisposed).not.toHaveBeenCalled();
  view.unmount();
  expect(controlReleased).toHaveBeenCalledOnce();
  expect(mediaDisposed).toHaveBeenCalledOnce();
});
