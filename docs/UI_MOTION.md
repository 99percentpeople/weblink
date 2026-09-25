# UI motion

Use the native JavaScript API from `motion`; the application does not load React.
The local Solid wrapper lives in `src/components/ui/motion.tsx`.

## Entrance, updates and exit

```tsx
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";

<AnimatePresence when={open()}>
  <Motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: 8 }}
    transition={{ duration: 0.18, ease: "easeOut" }}
  >
    Panel content
  </Motion.div>
</AnimatePresence>;
```

`Motion.*` supports HTML tags, their usual Solid attributes/ref, and object targets
for `initial`, `animate`, `exit`, and Motion's `transition` options. Updating an
`animate` target interrupts the previous animation at its current value.
`initial={false}` skips the first entrance. Reduced-motion preference is respected.

Use `native` for CSS property animations that must run in a secondary document,
such as the PiP toolbar. It uses `motion/mini` to resolve and start WAAPI animations
without waiting for the opener's animation frames. Use CSS `transform` keyframes
instead of aliases such as `x` or `y`, with duration/easing transitions.

Solid does not expose React's child reconciliation, so `AnimatePresence` takes an
explicit `when`. Do not put a conditional `Show` inside it: presence must retain
the same child until all registered exit animations finish. Exiting motion hosts
are inert and hidden from assistive technology. Reopening cancels pending removal.
This is a small local API, not a complete implementation of Motion for React;
variants, gesture props and keyed-list presence are not exposed.

Polymorphic UI components can use `as={Motion.button}` to keep their usual styles
and behavior. `conversations/chat-scroll-button.tsx` shares the return-to-bottom
button between direct and room chats, with presence-driven entrance/exit and an
inactive button while exiting.

## Layout changes

```tsx
import { Motion } from "@/components/ui/motion";
import {
  createMotionLayout,
  MotionLayout,
  layoutScroll,
} from "@/components/ui/motion-layout";

const layout = createMotionLayout();

<MotionLayout value={layout}>
  <Motion.article
    layout
    layoutId="camera"
    classList={{ expanded: expanded() }}
  >
    Camera view
  </Motion.article>
  <Motion.aside layout="height">
    <div use:layoutScroll ref={scroll.viewportRef}>
      Chat messages
    </div>
  </Motion.aside>
  <button
    onClick={() =>
      layout.transition(() => setExpanded((v) => !v))
    }
  >
    Toggle
  </button>
</MotionLayout>;
```

`MotionLayout` adds no DOM wrapper. Motion elements and native directives register
with the nearest group's Solid context through refs and unregister on owner
cleanup. The engine measures registered nodes; it does not discover them through
selectors or `data-motion-*` attributes. Outside a group, layout registration is a
no-op, so shared chat components can also render independently.

`layout` registers a moving view; it does not install an observer or automatically
watch every DOM change. `layoutId` identifies a view across hosts and must be
unique among moving views in one group. Without it, the registration's identity
is used. Groups are independent: Home and PiP can reuse the same IDs without
animating each other's nodes. Portal moves retain the registration, while physical
DOM containment determines which registered rail or panel currently hosts a view.

`layout.transition(update)` measures before/after the synchronous state update and
uses `motion/mini` to animate CSS transforms and opacity. Mark the moving views,
rather than both their ancestors and descendants. Use a separate host for
simultaneous `animate` transforms and layout transforms. Presence supplies exit
state directly; departing views remain registered until their owner is disposed,
so interrupted exits can reuse the visible frame.

For shared signals changed by another component/window, use
`const displayed = layout.value(source)` and render `displayed()`. It coalesces
changes in a microtask and commits them inside a layout transaction. Reading an
already-updated DOM in an ordinary effect cannot recover its previous layout.
Group measurement reads do not subscribe the calling effect to registered props.

The meeting canvas keeps the stage and PiP notice in overlapping presence layers
for crossfades, leaving chat mounted outside the canvas. The notice's large inner
host participates in sidebar layout transitions; its outer host owns opacity so
the two animations do not overwrite one another. Its content group receives size
compensation to keep text and the SVG proportional. Do not animate the whole
canvas with layout transforms as well as its individual video tiles.

`createMotionLayout({ afterUpdate: () => stage.measure() })` refreshes
application-owned layout calculations after the state update and before the
destination snapshot. The meeting uses this when the sidebar changes the stage
width, without adding another ResizeObserver. Its optional `root: () => element`
defers animation until the root exists and supplies fallback dimensions for
collapsed containers; group membership always comes from registration.

Supported roles compose with normal Solid refs and polymorphic UI components:

| Motion prop            | Native-element directive     | Behavior                                                                   |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `layout` / `layoutId`  | —                            | Animate a view's position and size.                                        |
| `layout="height"`      | —                            | Animate actual panel height, preserving text and controls.                 |
| `layoutScroll`         | `use:layoutScroll`           | Restore scroll offsets clamped by temporary destination measurement.       |
| `layoutContainer`      | `use:layoutContainer`        | Keep a collapsing host paintable and preserve its scroll offset.           |
| `layoutSize="avatar"`  | `use:layoutSize={"avatar"}`  | Compensate parent scaling while interpolating the child's own size.        |
| `layoutOverlay="name"` | `use:layoutOverlay={"name"}` | Preserve text size while interpolating overlay insets and available width. |

For example, use `<Tabs as={Motion.aside} layout="height">` and
`<ClientAvatar as={Motion.span} layoutSize="avatar">` without adding wrappers.
Import directives from `components/ui/motion-layout`. Directives apply to native
DOM elements; use Motion's polymorphic props for components. A component that only
forwards refs can call `createMotionLayoutRef(() => options)` in its own owner
beneath the provider, then compose that callback with its existing ref.

The scroll role only undoes the measurement side effect before the next scroll
event. It does not force bottom following or restore an old offset when animation
finishes; the conversation scroll controller continues to own reader intent.

Overlay compensation expects an absolutely positioned container stretched between
left/right insets. Use truncation inside it for long labels. Do not also put
`layout` or another transform animation on that same child. Correction IDs such
as `avatar` or `name` are local to their containing view and can repeat across tiles.

The meeting grid also routes observed size changes through the same transition.
Its centering offsets use the measured box too, preventing CSS from recentering
the old-sized tiles before the observer commits their new layout.
Source-list updates share its animation-frame queue, so views and grid dimensions
change in one transaction. The first measurement and hidden stages update directly;
continuous resizing interrupts from the visible animation frame. Synchronous
measurements inside explicit transitions consume pending resize work to avoid a
second animation for the same size.

Views retain their 16:9 destinations during meeting layout changes. Inside a
visible `layoutContainer`, list updates keep views in flow so the scroll range
survives and animation cleanup does not undo user scrolling. Views crossing host
boundaries temporarily leave flow; those hosts must retain their allotted size.
The internal `motion-layout-active` CSS class disables rail clipping only for
these transitions and is removed on completion or cleanup. Collapsing containers
stay paintable until their contents finish leaving.

The thumbnail rail has an explicit grid row, so an animating toolbar cannot
displace it. It uses ordinary horizontal scrolling: scroll snapping would follow
the transformed tiles and repeatedly adjust the offset during list updates.
The meeting keeps one existing ResizeObserver and retains video elements through
Solid Portals.
