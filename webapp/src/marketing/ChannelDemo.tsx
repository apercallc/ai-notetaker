/**
 * The hero's one memorable element: the product's real difference made
 * visible. Your microphone and the other side of the call are recorded as two
 * separate channels, so "you" and "everyone else" never blur together.
 *
 * Heights are fixed data (not random) so server and client render identically.
 * The waveform is explicitly labelled as an example, like the notes beneath it.
 */
const YOU = [
  8, 14, 26, 38, 44, 36, 48, 30, 22, 12, 6, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 10, 22, 34, 42, 30,
  46, 38, 24, 14, 8, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
];
const THEM = [
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 12, 26, 40, 34, 46, 28, 44, 36, 20, 30, 42, 24, 14, 8, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 14, 30, 44, 36, 26, 40, 32, 18, 26, 12, 8, 4, 4, 4, 4, 4,
];

const BAR = 6;
const GAP = 4;
const WIDTH = YOU.length * (BAR + GAP) - GAP;
const HEIGHT = 56;

function Wave({ heights, label }: { heights: number[]; label: string }) {
  return (
    <svg className="mk-wave" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true" data-channel={label}>
      {heights.map((height, index) => (
        <rect
          key={index}
          x={index * (BAR + GAP)}
          y={(HEIGHT - height) / 2}
          width={BAR}
          height={height}
          rx={BAR / 2}
        />
      ))}
    </svg>
  );
}

export function ChannelDemo() {
  return (
    <figure className="mk-demo" aria-labelledby="mk-demo-caption">
      <div className="mk-demo-bar">
        <span className="mk-rec-dot" aria-hidden="true" />
        <span>Recording Google Meet</span>
        <span className="mk-demo-time" aria-hidden="true">12:41</span>
      </div>
      <div className="mk-lane mk-lane--you">
        <span className="mk-lane-name">You</span>
        <Wave heights={YOU} label="Your microphone channel" />
      </div>
      <div className="mk-lane mk-lane--them">
        <span className="mk-lane-name">Everyone else</span>
        <Wave heights={THEM} label="The meeting's audio channel" />
      </div>
      <ul className="mk-notes" aria-label="Example notes">
        <li className="mk-note">
          <span className="mk-note-kind">Decision</span>
          <span>Ship the smaller update first and revisit pricing next sprint.</span>
        </li>
        <li className="mk-note">
          <span className="mk-note-kind">Action</span>
          <span>Share revised screens with the team by Thursday.</span>
        </li>
        <li className="mk-note">
          <span className="mk-note-kind">Question</span>
          <span>Does the trial need a card? Check with finance.</span>
        </li>
      </ul>
      <figcaption id="mk-demo-caption" className="mk-demo-caption">
        Example. Two separate channels, one set of notes.
      </figcaption>
    </figure>
  );
}
