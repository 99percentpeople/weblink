export function MeetingStatusLabel(props: {
  name: string;
  label: string;
  title?: string;
}) {
  return (
    <span
      role="status"
      class="min-w-0 truncate font-medium"
      title={props.title ?? props.label}
      aria-label={props.label}
    >
      {props.name}
    </span>
  );
}
