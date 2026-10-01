import type { SummaryBlock } from "@/lib/summaryFormat";

/** Renders parsed summary blocks as plain React elements (never as HTML). Shared by the note page and the editor preview. */
export function SummaryBlocks({ blocks }: { blocks: SummaryBlock[] }) {
  return (
    <div className="summary">
      {blocks.map((block, index) =>
        block.type === "heading" ? (
          <h3 key={index}>{block.text}</h3>
        ) : block.type === "list" ? (
          block.ordered ? (
            <ol key={index}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ol>
          ) : (
            <ul key={index}>{block.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
          )
        ) : (
          <p key={index}>{block.text}</p>
        ),
      )}
    </div>
  );
}
