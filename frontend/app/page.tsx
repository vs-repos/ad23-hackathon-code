import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="space-y-16">
      <section className="pt-6">
        <h1 className="max-w-3xl text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Your program is only as good as the hour it puts your best talk in.
        </h1>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-stone-700">
          Build the two-day Analyst Days agenda from your talk list — with speaker windows respected,
          lunch shifts staggered across four halls, and your strongest talks kept out of each
          other's time slots.
        </p>
        <div className="mt-8 flex items-center gap-5">
          <Link href="/agenda" className="btn px-5 py-2.5 text-base">
            Build the agenda
          </Link>
          <Link href="/agenda#grid" className="text-sm text-stone-600 underline underline-offset-4 hover:text-stone-900">
            See a sample two-day grid
          </Link>
        </div>
        <p className="mt-8 text-sm text-stone-500">No sign-up. Enter talks, run it, print it.</p>
      </section>

      <section className="grid gap-10 md:grid-cols-2">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">The spreadsheet doesn't know what you know</h2>
          <p className="mt-3 leading-relaxed text-stone-700">
            You already know which four talks will fill a hall and which two will fill a row of chairs.
            The spreadsheet knows none of it. It knows a grid, and it will happily put all four of your
            best talks in the same 14:20 slot across halls A, B, C and D — then show you a program that
            is technically complete and quietly wasteful.
          </p>
          <p className="mt-3 leading-relaxed text-stone-700">
            Then a speaker writes: <em>&ldquo;I can only be there Thursday morning.&rdquo;</em> You move one
            talk. Two other halls shift. The window breaks. You find out at 23:40 the night before you
            print.
          </p>
        </div>
        <div>
          <h2 className="text-xl font-semibold tracking-tight">And the day has a shape</h2>
          <p className="mt-3 leading-relaxed text-stone-700">
            Morning attendance is thinner than the afternoon. Some people take lunch instead of a talk,
            and the lunch queue is why halls go dark one at a time rather than all at once. By the last
            slot, nobody wants the hardest talk of the conference.
          </p>
          <p className="mt-3 leading-relaxed text-stone-700">
            That shape is not a secret. It is just not expressible in a grid of cells.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight">What changes</h2>
        <ul className="mt-4 space-y-3 border-l-2 border-stone-300 pl-6 text-stone-700">
          <li>
            <strong className="text-stone-900">Speaker windows become constraints, not notes.</strong> A talk
            outside its speaker's availability is never placed. Not flagged — never placed.
          </li>
          <li>
            <strong className="text-stone-900">Lunch runs in shifts while other halls keep talking.</strong>{' '}
            Three staggered shifts, each darkening only its own halls.
          </li>
          <li>
            <strong className="text-stone-900">Your interest rating does real work.</strong> Each talk
            carries a weight from 1 to 5; the scheduler keeps the 4s and 5s from sharing a start slot, and
            pushes heavy talks away from the last slot of the day.
          </li>
          <li>
            <strong className="text-stone-900">When it cannot work, it says why.</strong> You get the list
            of talks that don't fit, each with the constraint that blocks it. Not a truncated agenda
            with three talks missing.
          </li>
          <li>
            <strong className="text-stone-900">You can overrule it.</strong> Pin a talk to a cell and
            re-solve around the pin. The rest moves; your decision stays.
          </li>
        </ul>
        <p className="mt-5 max-w-3xl leading-relaxed text-stone-600">
          The effect is: fewer collisions among your strongest talks, no broken speaker promise, and a
          printed agenda you can defend line by line.
        </p>
      </section>

      <section>
        <h2 className="text-xl font-semibold tracking-tight">How it works, in four lines</h2>
        <ol className="mt-4 space-y-2 pl-5 text-stone-700">
          <li className="list-decimal">
            <strong className="text-stone-900">Enter the talks.</strong> Length, speaker, title, abstract,
            availability, unavailability, interest 1–5.
          </li>
          <li className="list-decimal">
            <strong className="text-stone-900">Set the day.</strong> Two days, four halls, registration,
            opening, coffee, three lunch shifts, evening program, closing.
          </li>
          <li className="list-decimal">
            <strong className="text-stone-900">Run it.</strong> The scheduler places every talk it can and
            explains every score.
          </li>
          <li className="list-decimal">
            <strong className="text-stone-900">Pin and re-run until it's right.</strong> Then export
            JSON or print the grid.
          </li>
        </ol>
      </section>

      <section className="border-t border-stone-200 pt-8">
        <h2 className="text-2xl font-semibold tracking-tight">Build the agenda</h2>
        <p className="mt-2 text-stone-600">Two days, four halls, one honest score.</p>
        <Link href="/agenda" className="btn mt-5 px-5 py-2.5 text-base">
          Build the agenda
        </Link>
      </section>
    </div>
  );
}
