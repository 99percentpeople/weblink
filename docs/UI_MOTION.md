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
import { createLayoutTransition } from "@/libs/hooks/layout-transition";

let area: HTMLDivElement | undefined;
const transitionLayout = createLayoutTransition(() => area);

<div ref={area}>
  <Motion.article
    layout
    layoutId="camera"
    classList={{ expanded: expanded() }}
  >
    Camera view
  </Motion.article>
  <button
    onClick={() =>
      transitionLayout(() => setExpanded((v) => !v))
    }
  >
    Toggle
  </button>
</div>;
```

`layout` registers a view in the explicit transition scope; it does not install an
observer or automatically watch every DOM change. `layoutId` identifies the same
view across hosts. The helper measures before/after the state update and uses
`motion/mini` to animate CSS transforms and opacity. Mark the moving views, rather
than both their ancestors and descendants. Use a separate host for simultaneous
`animate` transforms and layout transforms.

The meeting canvas keeps the stage and PiP notice in overlapping presence layers
for crossfades, leaving chat mounted outside the canvas. The notice's large inner
host participates in sidebar layout transitions; its outer host owns opacity so
the two animations do not overwrite one another. Its content group receives size
compensation to keep text and the SVG proportional. Do not animate the whole
canvas with layout transforms as well as its individual video tiles.

An optional third `createLayoutTransition` argument refreshes application-owned
layout calculations after the state update and before the destination snapshot.
The meeting uses it when the sidebar changes the stage width, without adding
another ResizeObserver. A descendant marked `data-motion-layout-size="avatar"`
gets scale compensation so its own dimensions interpolate without being stretched
by its parent's layout transform.

`data-motion-layout-height="stable-id"` animates a panel's measured height in the
same transition, including interruptions. It preserves normal text and controls
instead of scaling its contents; the chat sidebar uses it when the toolbar folds.

For a text overlay, use `data-motion-layout-overlay="name"` on an absolutely
positioned container stretched between left/right insets. It cancels the parent's
scale so text, padding and icons keep their normal size, interpolates the insets,
and animates the available width. Use truncation inside it for long labels. Do not
also put `layout` or another transform animation on that same child.

The meeting grid also routes observed size changes through the same transition.
Its centering offsets use the measured box too, preventing CSS from recentering
the old-sized tiles before the observer commits their new layout.
Source-list updates share its animation-frame queue, so views and grid dimensions
change in one transaction. The first measurement and hidden stages update directly;
continuous resizing interrupts from the visible animation frame. Synchronous
measurements inside explicit transitions consume pending resize work to avoid a
second animation for the same size.

Views retain their 16:9 destinations during meeting layout changes. Moving views
temporarily leave layout flow, so hosts must retain their allotted size. A host
marked `data-motion-layout-container="stable-id"` can stay paintable while its
contents leave and preserves its scroll offset. The meeting keeps one existing
ResizeObserver and retains video elements through Solid Portals.
