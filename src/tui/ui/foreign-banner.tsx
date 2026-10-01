export function ForeignBanner({ text }: { text: string }) {
  return (
    <box border borderStyle="single">
      <text fg="gray">{text}</text>
    </box>
  );
}
