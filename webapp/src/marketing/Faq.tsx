import { ChevronDown } from "lucide-react";
import { FAQS, type FaqTopic } from "./content";
import { Icon } from "./Icon";

/** Native <details>: keyboard and screen-reader friendly with no client JavaScript. */
export function Faq({ topic }: { topic?: FaqTopic }) {
  const items = topic ? FAQS.filter((faq) => faq.topics?.includes(topic)) : FAQS;
  return (
    <div className="mk-faq">
      {items.map((faq) => (
        <details key={faq.question}>
          <summary>
            {faq.question}
            <Icon as={ChevronDown} />
          </summary>
          <p>{faq.answer}</p>
        </details>
      ))}
    </div>
  );
}
