import {
  Show,
  type Component,
  type ParentProps,
} from "solid-js";
import {
  MeetingSessionContext,
  type MeetingSession,
} from "@/libs/state/meeting-session-context";
import { MeetingPipWindow } from "@/routes/home/components/meeting-pip-window";
import "@/routes/home/index.css";
/** Lives above the router's pages, so a PiP window survives leaving Home. */
export function MeetingSessionView(props: {
  session: MeetingSession;
  confirmation: Component;
}) {
  const session = props.session;
  return (
    <>
      <props.confirmation />
      <Show when={session.pip.window()} keyed>
        {(window) => (
          <MeetingPipWindow
            window={window}
            sources={session.sources()}
            featuredId={session.selected()?.id ?? null}
            railCollapsed={session.railCollapsed()}
            onRailCollapsedChange={session.setRailCollapsed}
            toolbarCollapsed={session.toolbarCollapsed()}
            onToolbarCollapsedChange={
              session.setToolbarCollapsed
            }
            onSelect={session.setPinnedId}
            controls={session.controls}
            onLeave={session.leave}
          />
        )}
      </Show>
    </>
  );
}

export function MeetingSessionProvider(
  props: ParentProps<{
    value: MeetingSession;
    confirmation: Component;
  }>,
) {
  return (
    <MeetingSessionContext.Provider value={props.value}>
      {props.children}
      <MeetingSessionView
        session={props.value}
        confirmation={props.confirmation}
      />
    </MeetingSessionContext.Provider>
  );
}
