import type { HighlightPart } from "@/lib/snippet";

export function Highlight({ parts }: { parts: HighlightPart[] }) {
  return (
    <>
      {parts.map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
    </>
  );
}
