/**
 * Learning evidence and private notes (Rules 0375 to 0384), driven through the Learning domain and
 * use cases over the in-memory adapters (the notes store, the learning records the reader already
 * stores, the event publisher), and through the reader's notes panel state over the browser
 * storage adapter, notes-localstorage, with a Storage the test holds.
 */
import "../../support/svelte-runes-shim.ts";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterEach, expect, vi } from "vitest";
import {
  attemptsFromRecords,
  evidenceAtStep,
  learningObjectRoute,
  noteKey,
  stepRef,
  type Attempt,
  type Evidence,
  type EvidenceKind,
  type LabSteps,
  type LearningRecordRow,
  type NotesPanelState,
  type NotesPanelView,
  type StepRef
} from "@tutors/domain/learning";
import { openRequest } from "@tutors/domain/assistance";
import {
  annotate,
  exportNotes,
  openStepNotes,
  recordEvidence,
  saveNote,
  shareReflection,
  stepDiagnostics,
  withMemoryFallback
} from "../../../../packages/application/src/index.ts";
import type { NotesStore } from "../../../../packages/application/src/ports/index.ts";
import {
  FixedClock,
  InMemoryAssistanceStore,
  InMemoryFeedbackStore,
  InMemoryInsightsRead,
  InMemoryLearningRecords,
  InMemoryNotesStore,
  RecordingPublisher
} from "../../../../packages/application/src/testing/index.ts";
import type { StepDiagnostic } from "@tutors/domain/insights";
import type { Annotation } from "@tutors/domain/feedback";
import type { Lo } from "@tutors/domain/course";
import type { HelpRequest } from "@tutors/domain/assistance";
import { localStorageNotes, type NotesStorage } from "@tutors/notes-localstorage";
import { anonymousAdapters, configureAdapters } from "../../../../packages/adapters/driving/svelte-state/src/adapters.ts";
import { notesService } from "../../../../packages/adapters/driving/svelte-state/src/learning/notes.svelte.ts";

const feature = await loadFeature("tests/bdd/features/student/learning-evidence.feature");

const READER = "https://reader.example";

/** A browser's Storage the test can read, and fill up: a full one refuses every write as browsers do. */
class TestStorage implements NotesStorage {
  readonly items = new Map<string, string>();
  full = false;
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.full) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  clear() {
    this.items.clear();
  }
}
const readerUrl = (ref: StepRef) => `${READER}${ref.labRoute.replace(/^\/lab\/[^/]+/, `/lab/${ref.courseId}`)}/${ref.stepId}`;

describeFeature(feature, ({ Background, Rule }) => {
  let courseId: string;
  let labRoute: string;
  let stepIds: string[];
  let clock: FixedClock;
  let notes: InMemoryNotesStore;
  let store: NotesStore;
  let warnings: number;
  let feedback: InMemoryFeedbackStore;
  let publisher: RecordingPublisher;
  let records: LearningRecordRow[];
  let recordsPort: InMemoryLearningRecords;
  let attempts: Attempt[];
  let evidence: Evidence[];
  let listed: Evidence[];
  let panel: NotesPanelState;
  let view: NotesPanelView;
  let exported: string;
  let identified: StepRef | null;
  let request: HelpRequest;
  let annotation: Annotation;
  let diagnostics: StepDiagnostic[];
  let fetchSpy: ReturnType<typeof vi.fn>;

  const at = (stepId: string): StepRef => ({ courseId, labRoute, stepId });
  const lab = (): LabSteps => ({ courseId, labRoute, stepIds });
  const write = (body: string, stepId: string) => saveNote({ notes: store, clock })({ ref: at(stepId), body, labTitle: "Lab One", stepTitle: `Step ${stepId}` });

  let browser: TestStorage;
  let typedAt: number;
  let sessionOnlyTold: number;

  // A step is a test of its own, so only the globals are undone after each; the panel's state is
  // put back at the start of every scenario, in the Background.
  afterEach(() => vi.unstubAllGlobals());

  /** The reader's composition: the notes panel over the browser storage adapter. */
  const composeReaderNotes = () => {
    vi.useFakeTimers();
    notesService.reset();
    configureAdapters(anonymousAdapters({ notes: localStorageNotes(() => browser), clock }));
    sessionOnlyTold = 0;
  };
  const typeInPanel = async (_ctx: unknown, _learner: string, body: string, stepId: string) => {
    if (!vi.isFakeTimers()) composeReaderNotes();
    const before = notesService.sessionOnly.value;
    await notesService.arrive(at(stepId), { labTitle: "Lab One", stepTitle: `Step ${stepId}` });
    typedAt = Date.now();
    notesService.edit(body);
    await vi.advanceTimersByTimeAsync(1000);
    if (!before && notesService.sessionOnly.value) sessionOnlyTold++;
  };

  Background(({ Given }) => {
    Given("the lab {string} of the course {string} has the steps {string}", (_ctx, route: string, course: string, steps: string) => {
      vi.useRealTimers();
      notesService.reset();
      configureAdapters(anonymousAdapters());
      browser = new TestStorage();
      labRoute = route;
      courseId = course;
      stepIds = steps.split(",").map((s) => s.trim());
      clock = new FixedClock();
      notes = new InMemoryNotesStore();
      warnings = 0;
      store = withMemoryFallback(notes, () => warnings++);
      feedback = new InMemoryFeedbackStore();
      publisher = new RecordingPublisher();
      records = [];
      evidence = [];
    });
  });

  /**
   * A learner's record of a lab page as the reader writes it: the route parameter of
   * `/lab/[courseid]/[...loid]` is the page's address after the course id, the lab's path and the
   * step id, or the lab's path alone when the lab is opened at its own address.
   */
  const row = (learner: string, count: number, stepId?: string, route = labRoute): LearningRecordRow => {
    const loid = [...route.split("/").slice(3), ...(stepId ? [stepId] : [])].join("/");
    return {
      course_id: courseId,
      student_id: learner,
      lo_id: learningObjectRoute({ route } as Lo, loid),
      duration: count * 2,
      count,
      date_last_accessed: "2026-01-05T09:00:00.000Z",
      type: "step"
    };
  };
  const keep = (rows: LearningRecordRow[]) => {
    records = rows;
    recordsPort = new InMemoryLearningRecords([], records as never, []);
  };
  const visited = (_ctx: unknown, learner: string, first: string, times: number, second: string) => keep([row(learner, times, first), row(learner, 1, second)]);
  const onlyAttempt = (_ctx: unknown, learner: string, visits: number, stepId: string) => {
    expect(attempts.map((x) => [x.learnerId, x.ref.stepId, x.visits])).toEqual([[learner, stepId, visits]]);
  };
  const readAttempts = async () => {
    const read = vi.spyOn(recordsPort, "learningRecords");
    attempts = attemptsFromRecords((await recordsPort.learningRecords(courseId)) as unknown as LearningRecordRow[], lab());
    expect(read).toHaveBeenCalledTimes(1);
  };
  const attemptAt = (stepId: string) => attempts.find((a) => a.ref.stepId === stepId)!;

  Rule(
    "Tutors shall identify a lab step by its course id, lab route and step id, and carry that reference on every assistance, feedback and insights record.",
    ({ RuleScenario }) => {
      RuleScenario("A step is its course, its lab and its own id", ({ When, Then, And }) => {
        When("tutors identifies the step {string}", (_ctx, stepId: string) => {
          identified = stepRef(courseId, labRoute, stepId);
        });
        Then("the step reference shall be the course {string}, the lab {string} and the step {string}", (_ctx, course: string, route: string, stepId: string) => {
          expect(identified).toEqual({ courseId: course, labRoute: route, stepId });
        });
        And("a reference missing its course, its lab or its step shall not identify a step", () => {
          expect([stepRef("", labRoute, "02"), stepRef(courseId, " ", "02"), stepRef(courseId, labRoute, null)]).toEqual([null, null, null]);
        });
      });

      RuleScenario("Help requests, annotations and insights carry the step", ({ Given, And, When, Then }) => {
        Given("{string} has asked for help as {string} on the step {string}", async (_ctx, learner: string, kind: "stuck", stepId: string) => {
          request = await new InMemoryAssistanceStore().open(openRequest(at(stepId), { login: learner, name: null }, kind, clock.now().toISOString()));
        });
        And("an educator has annotated the step {string}", async (_ctx, stepId: string) => {
          const result = await annotate({ store: feedback, clock, educatorsOf: async () => ["ellen"] })(
            { anchor: { ref: at(stepId) }, audience: { everyone: true }, body: "Await it." },
            { login: "ellen" }
          );
          if (!result.ok) throw new Error(result.reason);
          annotation = result.annotation;
        });
        When("tutors computes the day's diagnostics", async () => {
          diagnostics = await stepDiagnostics({ insights: new InMemoryInsightsRead([request], [annotation]) })(courseId, clock.now().toISOString().slice(0, 10));
        });
        Then("the help request, the annotation and the diagnostic shall each carry the reference of the step {string}", (_ctx, stepId: string) => {
          expect([request.ref, annotation.anchor.ref, ...diagnostics.map((d) => d.ref)]).toEqual([at(stepId), at(stepId), at(stepId)]);
        });
      });
    }
  );

  Rule("Tutors shall derive a learner's attempts at a step from stored learning records, never from a second record of its own.", ({ RuleScenario }) => {
    RuleScenario("Attempts are read from the learning records", ({ Given, When, Then, And }) => {
      Given("the learning records show {string} visited the step {string} {number} times and the step {string} once", visited);
      When("tutors reads the attempts at the lab", readAttempts);
      Then(
        "{string} shall have {number} visits at the step {string} and {number} visit at the step {string}",
        (_ctx, learner: string, first: number, a: string, second: number, b: string) => {
          expect(attempts.map((x) => [x.learnerId, x.ref.stepId, x.visits])).toEqual([
            [learner, a, first],
            [learner, b, second]
          ]);
        }
      );
      And("tutors shall have read nothing but the learning records", () => {
        expect(attempts.map((a) => a.activeBlocks)).toEqual(records.map((r) => r.duration));
        expect(attempts.map((a) => a.lastAt)).toEqual(records.map((r) => r.date_last_accessed));
      });
    });

    RuleScenario("Two labs that reuse a step id keep their attempts apart", ({ Given, When, Then }) => {
      Given(
        "the learning records show {string} visited the step {string} of the lab {string} {number} times and the step {string} of the lab {string} {number} times",
        (_ctx, learner: string, a: string, labA: string, first: number, b: string, labB: string, second: number) => {
          expect(labA).toBe(labRoute);
          keep([row(learner, first, a, labA), row(learner, second, b, labB)]);
          // The reader writes each under its own lab, so the rows differ though the step ids do not.
          expect(records[0].lo_id).not.toBe(records[1].lo_id);
        }
      );
      When("tutors reads the attempts at the lab", readAttempts);
      Then("{string} shall have {number} visits at the step {string} and no other attempt", onlyAttempt);
    });

    RuleScenario("Opening the lab at its own address counts toward its first step", ({ Given, When, Then }) => {
      Given("the learning records show {string} opened the lab {number} times and visited the step {string} once", (_ctx, learner: string, opened: number, stepId: string) => {
        expect(stepId).toBe(stepIds[0]);
        keep([row(learner, opened), row(learner, 1, stepId)]);
      });
      When("tutors reads the attempts at the lab", readAttempts);
      Then("{string} shall have {number} visits at the step {string} and no other attempt", onlyAttempt);
    });
  });

  Rule("When a learner records evidence at a step, tutors shall publish an evidence-recorded event carrying the step reference and the evidence kind.", ({ RuleScenario }) => {
    RuleScenario("A shared snippet is evidence at its step", ({ When, Then }) => {
      When("{string} records a {string} as evidence at the step {string}", async (_ctx, learner: string, kind: EvidenceKind, stepId: string) => {
        await recordEvidence({ publish: (e) => publisher.publish(e) })(learner, { kind, ref: at(stepId), id: "gist-7", at: clock.now().toISOString() });
      });
      Then("tutors shall publish one evidence-recorded event for {string} at the step {string} of kind {string}", (_ctx, learner: string, stepId: string, kind: string) => {
        const events = publisher.events.filter((e) => e.type === "evidence-recorded");
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ learnerId: learner, evidence: { ref: at(stepId), kind } });
      });
    });
  });

  Rule("While a learner has recorded evidence at a step, tutors shall list that evidence under the step with its kind and date, newest first.", ({ RuleScenario }) => {
    const recorded = (_ctx: unknown, _learner: string, kind: EvidenceKind, stepId: string, day: string) => {
      evidence.push({ kind, ref: at(stepId), id: `${kind}-${day}`, at: `${day}T09:00:00.000Z` });
    };
    const list = (_ctx: unknown, stepId: string) => {
      listed = evidenceAtStep(evidence, at(stepId));
    };
    RuleScenario("Evidence at the step is listed newest first", ({ Given, And, When, Then }) => {
      Given("{string} recorded a {string} at the step {string} on {string}", recorded);
      And("{string} recorded a {string} at the step {string} on {string}", recorded);
      And("she later recorded a {string} at the step {string} on {string}", (ctx, kind: EvidenceKind, stepId: string, day: string) => recorded(ctx, "", kind, stepId, day));
      When("tutors lists the evidence at the step {string}", list);
      Then("the list shall be {string}", (_ctx, expected: string) => {
        expect(listed.map((e) => `${e.kind} on ${e.at.slice(0, 10)}`).join(", ")).toBe(expected);
      });
    });
    RuleScenario("A step with no evidence lists nothing", ({ Given, When, Then }) => {
      Given("{string} recorded a {string} at the step {string} on {string}", recorded);
      When("tutors lists the evidence at the step {string}", list);
      Then("the list shall be empty", () => expect(listed).toEqual([]));
    });
  });

  Rule(
    "If a learning record names a step that no longer exists in the course, then tutors shall keep the attempt under the lab with the step marked as removed.",
    ({ RuleScenario }) => {
      RuleScenario("A renamed step keeps its history", ({ Given, When, Then, And }) => {
        Given("the learning records show {string} visited the step {string} {number} times and the step {string} once", visited);
        When("tutors reads the attempts at the lab", readAttempts);
        Then("the attempt at the step {string} shall be kept under the lab {string} marked as removed", (_ctx, stepId: string, route: string) => {
          expect(attemptAt(stepId)).toMatchObject({ ref: { labRoute: route, stepId }, removed: true, visits: 1 });
        });
        And("the attempt at the step {string} shall not be marked as removed", (_ctx, stepId: string) => {
          expect(attemptAt(stepId).removed).toBe(false);
        });
      });
    }
  );

  Rule(
    "When a learner edits the note of a lab step, tutors shall keep the note in the browser under the step's reference within 1 second and send nothing to a server.",
    ({ RuleScenario }) => {
      RuleScenario("A note is kept in the browser", ({ When, Then, And }) => {
        let editedAt: number;
        When("{string} writes {string} in the note of the step {string}", async (_ctx, _learner: string, body: string, stepId: string) => {
          fetchSpy = vi.fn();
          vi.stubGlobal("fetch", fetchSpy);
          editedAt = clock.nowMs();
          await write(body, stepId);
        });
        Then("the note shall be kept under {string} within 1 second", (_ctx, key: string) => {
          const [kept] = [...notes.notes.values()];
          expect(noteKey(kept.ref)).toBe(key);
          expect(Date.parse(kept.updatedAt) - editedAt).toBeLessThanOrEqual(1000);
        });
        And("nothing shall have been sent to a server", () => {
          expect(fetchSpy).not.toHaveBeenCalled();
          expect(publisher.events).toEqual([]);
        });
      });
      RuleScenario("The notes panel keeps a typed note in the browser's local storage", ({ When, Then, And }) => {
        When("{string} types {string} in the notes panel at the step {string}", async (ctx, learner: string, body: string, stepId: string) => {
          fetchSpy = vi.fn();
          vi.stubGlobal("fetch", fetchSpy);
          composeReaderNotes();
          await typeInPanel(ctx, learner, body, stepId);
        });
        Then("the browser's local storage shall hold {string} under {string} within 1 second", (_ctx, body: string, key: string) => {
          const kept = JSON.parse(browser.getItem(key) ?? "null");
          expect(kept?.body).toBe(body);
          expect(kept?.ref).toEqual(at("02"));
          expect(Date.now() - typedAt).toBeLessThanOrEqual(1000);
          expect(notesService.saveState.value).toBe("saved");
        });
        And("nothing shall have been sent to a server", () => {
          expect(fetchSpy).not.toHaveBeenCalled();
        });
      });
    }
  );

  const twoNotes = async (_ctx: unknown, _learner: string, first: string, a: string, second: string, b: string) => {
    await write(first, a);
    await write(second, b);
  };

  Rule(
    "While a learner moves between steps and labs of a course, tutors shall show each step's own note in the notes panel and keep the panel's open, minimised and width state.",
    ({ RuleScenario }) => {
      const panelAt = async (_ctx: unknown, width: number, stepId: string) => {
        panel = { open: true, minimised: false, width };
        view = await openStepNotes({ notes: store })(panel, at(stepId));
      };
      const arrive = async (_ctx: unknown, _learner: string, stepId: string) => {
        view = await openStepNotes({ notes: store })({ open: view.open, minimised: view.minimised, width: view.width }, at(stepId));
      };
      const shows = (_ctx: unknown, body: string) => expect(view.note?.body).toBe(body);
      const kept = (_ctx: unknown, width: number) => expect({ open: view.open, minimised: view.minimised, width: view.width }).toEqual({ open: true, minimised: false, width });
      RuleScenario("Moving to the next step swaps the note and keeps the panel", ({ Given, And, When, Then }) => {
        Given("{string} has the note {string} at the step {string} and {string} at the step {string}", twoNotes);
        And("the notes panel is open, not minimised and {number} pixels wide at the step {string}", panelAt);
        When("{string} moves to the step {string}", arrive);
        Then("the notes panel shall show {string}", shows);
        And("the notes panel shall still be open, not minimised and {number} pixels wide", kept);
      });
      RuleScenario("Staying on a step keeps its note and the panel", ({ Given, And, When, Then }) => {
        Given("{string} has the note {string} at the step {string} and {string} at the step {string}", twoNotes);
        And("the notes panel is open, not minimised and {number} pixels wide at the step {string}", panelAt);
        When("{string} stays on the step {string}", arrive);
        Then("the notes panel shall show {string}", shows);
        And("the notes panel shall still be open, not minimised and {number} pixels wide", kept);
      });
    }
  );

  const exportCourse = (title: string) => exportNotes({ notes: store })({ courseId, title, readerUrl });

  Rule(
    "When a learner exports a course's notes, tutors shall produce one markdown document with a heading per lab, a sub-heading per step linking to the reader, and each note's body, kind and date.",
    ({ RuleScenario }) => {
      RuleScenario("A course's notes export as one document", ({ Given, When, Then, And }) => {
        Given("{string} has the note {string} at the step {string} and {string} at the step {string}", twoNotes);
        When("{string} exports the notes of the course titled {string}", async (_ctx, _learner: string, title: string) => {
          exported = await exportCourse(title);
        });
        Then("the document shall open with the heading {string}", (_ctx, heading: string) => {
          expect(exported.split("\n")[0]).toBe(heading);
        });
        And("the document shall have one lab heading {string}", (_ctx, heading: string) => {
          expect(exported.split("\n").filter((line) => line.startsWith("## "))).toEqual([heading]);
        });
        And("the document shall have the step heading {string} followed by {string} and {string}", (_ctx, heading: string, stamp: string, body: string) => {
          const lines = exported.split("\n");
          const i = lines.indexOf(heading);
          expect(i).toBeGreaterThan(0);
          expect(lines.slice(i + 1, i + 5).filter(Boolean)).toEqual([stamp, body]);
        });
      });
    }
  );

  Rule(
    "If browser storage is unavailable or full, then tutors shall keep the notes of the session in memory, tell the learner once that the notes are kept for this session only, and still export them.",
    ({ RuleScenario }) => {
      RuleScenario("Notes survive the session when storage refuses them", ({ Given, When, And, Then }) => {
        Given("browser storage refuses every write", () => {
          notes.failing = true;
        });
        When("{string} writes {string} in the note of the step {string}", async (_ctx, _learner: string, body: string, stepId: string) => {
          await write(body, stepId);
        });
        And("{string} writes {string} in the note of the step {string}", async (_ctx, _learner: string, body: string, stepId: string) => {
          await write(body, stepId);
        });
        Then("tutors shall have told {string} once that the notes are kept for this session only", () => {
          expect(warnings).toBe(1);
        });
        And("the note of the step {string} shall read {string}", async (_ctx, stepId: string, body: string) => {
          expect((await store.get(at(stepId)))?.body).toBe(body);
        });
        And("the export of the course shall contain {string} and {string}", async (_ctx, a: string, b: string) => {
          const doc = await exportCourse("Web Development");
          expect(doc).toContain(a);
          expect(doc).toContain(b);
        });
      });
      RuleScenario("The notes panel keeps the session's notes when local storage is full", ({ Given, When, And, Then }) => {
        Given("the browser's local storage is full", () => {
          composeReaderNotes();
          browser.full = true;
        });
        When("{string} types {string} in the notes panel at the step {string}", typeInPanel);
        And("{string} types {string} in the notes panel at the step {string}", typeInPanel);
        Then("the notes panel shall have said once that the notes are kept for this session only", () => {
          expect(notesService.sessionOnly.value).toBe(true);
          expect(sessionOnlyTold).toBe(1);
          expect(browser.items.size).toBe(0);
        });
        And("the notes panel's export of the course shall contain {string} and {string}", async (_ctx, a: string, b: string) => {
          const doc = await notesService.exportCourse({ courseId, title: "Web Development", readerUrl });
          expect(doc).toContain(a);
          expect(doc).toContain(b);
        });
      });
    }
  );

  Rule("Where a learner shares a note as a reflection, tutors shall copy it to the feedback context and leave the private note unchanged.", ({ RuleScenario }) => {
    const hasNote = async (_ctx: unknown, _learner: string, body: string, stepId: string) => {
      await write(body, stepId);
    };
    RuleScenario("A shared note becomes a reflection", ({ Given, When, Then, And }) => {
      Given("{string} has the note {string} at the step {string}", hasNote);
      When("{string} shares the note of the step {string} as a reflection", async (_ctx, learner: string, stepId: string) => {
        const shared = await shareReflection({ store: feedback, notes: store, clock })(at(stepId), learner);
        expect(shared.ok).toBe(true);
      });
      Then("the feedback context shall hold a reflection by {string} at the step {string} reading {string}", async (_ctx, learner: string, stepId: string, body: string) => {
        expect((await feedback.reflections(courseId, learner)).map((r) => [r.ref, r.body])).toEqual([[at(stepId), body]]);
      });
      And("the note of the step {string} shall still read {string}", async (_ctx, stepId: string, body: string) => {
        expect((await store.get(at(stepId)))?.body).toBe(body);
      });
    });
    RuleScenario("An unshared note stays private", ({ Given, When, Then }) => {
      Given("{string} has the note {string} at the step {string}", hasNote);
      When("{string} keeps the note of the step {string} to herself", () => {});
      Then("the feedback context shall hold no reflection by {string}", async (_ctx, learner: string) => {
        expect(await feedback.reflections(courseId, learner)).toEqual([]);
      });
    });
  });
});
