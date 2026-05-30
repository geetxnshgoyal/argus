export function ShellPage(props: { title: string; summary: string; milestone: string }) {
  return (
    <section>
      <h1>{props.title}</h1>
      <p className="lead">{props.summary}</p>
      <p className="muted">Coming in {props.milestone}. Sign-in arrives in M1.</p>
    </section>
  );
}
