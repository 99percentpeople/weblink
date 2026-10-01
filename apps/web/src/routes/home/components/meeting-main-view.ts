export interface MeetingMainFeatures {
  active(): boolean;
  /** End input and presentation modes, without stopping the shared media. */
  stop(): Promise<boolean>;
}

export type RegisterMeetingMainFeatures = (
  id: string,
  features: MeetingMainFeatures,
) => () => void;

/** Serializes user-initiated main-view changes around confirmation and cleanup. */
export function createMeetingMainView(options: {
  current(): string | undefined;
  valid(id: string | undefined): boolean;
  confirm(): Promise<boolean>;
  shared?: MeetingMainFeatures;
  onError(): void;
}) {
  const owners = new Map<string, MeetingMainFeatures>();
  let pending = false;
  let generation = 0;
  const register: RegisterMeetingMainFeatures = (
    id,
    features,
  ) => {
    owners.set(id, features);
    return () => {
      if (owners.get(id) === features) owners.delete(id);
    };
  };
  const active = (id = options.current()) =>
    !!id &&
    (!!owners.get(id)?.active() ||
      !!options.shared?.active());
  const change = async (
    next: string | undefined,
    apply: () => void,
  ): Promise<boolean> => {
    if (pending || !options.valid(next)) return false;
    const current = options.current();
    if (current === next || !active(current)) {
      apply();
      return true;
    }
    pending = true;
    const version = generation;
    const owner = current ? owners.get(current) : undefined;
    const stillCurrent = () =>
      generation === version &&
      options.current() === current &&
      (!current || owners.get(current) === owner) &&
      options.valid(next);
    try {
      if (!(await options.confirm()) || !stillCurrent())
        return false;
      const modes = [owner, options.shared].filter(
        (mode): mode is MeetingMainFeatures => !!mode,
      );
      const stopped = await Promise.all(
        modes.map((mode) => mode.stop()),
      );
      if (!stopped.every(Boolean)) {
        options.onError();
        return false;
      }
      // Closing document PiP may mount a new tile owner. The selected source
      // and room generation must still match, but its old view need not exist.
      if (
        generation !== version ||
        options.current() !== current ||
        !options.valid(next)
      )
        return false;
      apply();
      return true;
    } catch {
      options.onError();
      return false;
    } finally {
      pending = false;
    }
  };
  return {
    register,
    active,
    change,
    remove: (id: string) => {
      generation++;
      // Source removal is forced, not a user layout choice. Cancel requests
      // too: an avatar controller can outlive its camera's source identity.
      void owners.get(id)?.stop().catch(options.onError);
    },
    invalidate: () => {
      generation++;
    },
  };
}
