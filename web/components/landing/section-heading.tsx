export function SectionHeading({
  index,
  title,
}: {
  index: string;
  title: string;
}) {
  return (
    <div className="mb-8 flex items-baseline gap-3 sm:mb-12">
      <span className="font-mono text-sm text-muted-foreground">{index} /</span>
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
    </div>
  );
}
