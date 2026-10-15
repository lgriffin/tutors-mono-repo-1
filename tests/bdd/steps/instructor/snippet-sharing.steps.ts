// @vitest-environment happy-dom
/**
 * Snippet sharing (issue #155) and lecturer broadcasts (issue #78), driven through the application's
 * use cases over the in-memory adapters: the SnippetStore the reader's server writes to, the
 * CourseNotices port both notices travel, and the CourseSource the educator check reads. The
 * reader's toasts are the notice service that every student tab runs.
 */
import "../../support/svelte-runes-shim.ts";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import {
  activeSnippets,
  broadcastToCourse,
  courseEducators,
  createBroadcastLimiter,
  isCourseEducator,
  shareSnippet,
  SNIPPET_TTL_MS,
  type BroadcastResult,
  type EducatorCheck,
  type ShareSnippetResult
} from "../../../../packages/application/src/index.ts";
import type { CourseNotice, LecturerBroadcast, SharedSnippet } from "../../../../packages/application/src/ports/index.ts";
import { FixedClock, InMemoryCourseNotices, InMemoryCourseSource, InMemorySnippetStore } from "../../../../packages/application/src/testing/index.ts";
import { noticeService } from "../../../../packages/adapters/driving/svelte-state/src/community/services/notices.ts";
import { snippetService } from "../../../../packages/adapters/driving/svelte-state/src/community/services/snippets.ts";
import { anonymousAdapters, configureAdapters } from "../../../../packages/adapters/driving/svelte-state/src/adapters.ts";

const feature = await loadFeature("tests/bdd/features/instructor/snippet-sharing.feature");

const HOUR = 60 * 60 * 1000;
const list = (csv: string) => csv.split(",").map((s) => s.trim()).filter(Boolean);

describeFeature(feature, ({ Rule }) => {
  let clock: FixedClock;
  let store: InMemorySnippetStore;
  let notices: InMemoryCourseNotices;
  let learner: { login: string; name: string | null };
  let courseId: string;
  let shared: ShareSnippetResult;
  let sharedAt: number;

  /** The reader's server, composed for one scenario. */
  const freshReader = () => {
    clock = new FixedClock();
    store = new InMemorySnippetStore(clock);
    notices = new InMemoryCourseNotices();
    noticeService.reset();
    configureAdapters({ ...anonymousAdapters({ notices, clock, snippets: store }), anonymous: false });
  };
  const share = (content: string, filename: string, loTitle: string) => {
    sharedAt = clock.nowMs();
    return shareSnippet({ store, notices, clock })({ courseId, filename, content, loTitle, loRoute: `/lab/${courseId}/lab-02`, title: "" }, learner);
  };
  const signedIn = (_ctx: unknown, login: string, course: string) => {
    freshReader();
    learner = { login, name: login };
    courseId = course;
  };
  const sharesSnippet = async (_ctx: unknown, content: string, filename: string, lab: string) => {
    shared = await share(content, filename, lab);
  };
  const sharedThree = async (_ctx: unknown, count: number) => {
    for (let i = 0; i < count; i++) expect((await share(`snippet ${i}`, `s${i}.txt`, "Lab 01")).ok).toBe(true);
  };
  const refused = (_ctx: unknown, reason: string) => expect(shared).toEqual({ ok: false, reason });
  const kept = async (_ctx: unknown, count: number, course: string) => {
    expect(store.rows.filter((row) => row.courseId === course)).toHaveLength(count);
  };
  const published = (_ctx: unknown, type: string, course: string) => {
    expect(notices.posted.filter((n) => n.type === type && n.courseId === course)).toHaveLength(1);
  };

  Rule("When a signed-in student shares a snippet from a lab, the reader shall keep it for the course's educators with an expiry 48 hours after it was shared.", ({ RuleScenario }) => {
    RuleScenario("A student shares the error they are seeing", ({ Given, When, Then, And }) => {
      Given("{string} is signed in to the course {string}", signedIn);
      When("she shares the snippet {string} named {string} from {string}", sharesSnippet);
      Then("the reader shall keep the snippet for {string} as {string} with the filename {string} and the lab {string}", (_ctx, course: string, login: string, filename: string, lab: string) => {
        expect(shared.ok).toBe(true);
        expect(store.rows).toHaveLength(1);
        expect(store.rows[0]).toMatchObject({ courseId: course, learnerId: login, filename, loTitle: lab, content: "TypeError at step3.js:14" });
      });
      And("the snippet shall expire {int} hours after it was shared", (_ctx, hours: number) => {
        expect(hours * HOUR).toBe(SNIPPET_TTL_MS);
        expect(store.rows[0].expiresAt).toBe(new Date(sharedAt + hours * HOUR).toISOString());
        expect(shared).toMatchObject({ ok: true, expiresAt: store.rows[0].expiresAt });
      });
    });
  });

  Rule("If a student has shared 3 snippets with a course in the last hour, then the reader shall refuse the next share until the hour has passed.", ({ RuleScenario }) => {
    RuleScenario("A fourth snippet in the hour is refused", ({ Given, And, When, Then }) => {
      Given("{string} is signed in to the course {string}", signedIn);
      And("she has shared {int} snippets in the last hour", sharedThree);
      When("she shares the snippet {string} named {string} from {string}", sharesSnippet);
      Then("the reader shall refuse the share as {string}", refused);
      And("the reader shall keep {int} snippets for {string}", kept);
    });
    RuleScenario("The hour passes", ({ Given, And, When, Then }) => {
      Given("{string} is signed in to the course {string}", signedIn);
      And("she has shared {int} snippets in the last hour", sharedThree);
      And("{int} minutes pass", (_ctx, minutes: number) => clock.advance(minutes * 60 * 1000));
      When("she shares the snippet {string} named {string} from {string}", sharesSnippet);
      Then("the reader shall keep {int} snippets for {string}", kept);
    });
  });

  Rule("If a shared snippet is empty or larger than 400 kB, then the reader shall refuse the share without keeping anything.", ({ RuleScenario }) => {
    RuleScenario("An empty snippet", ({ Given, When, Then, And }) => {
      Given("{string} is signed in to the course {string}", signedIn);
      When("she shares the snippet {string} named {string} from {string}", sharesSnippet);
      Then("the reader shall refuse the share as {string}", refused);
      And("the reader shall keep {int} snippets for {string}", kept);
    });
    RuleScenario("An oversized snippet", ({ Given, When, Then, And }) => {
      Given("{string} is signed in to the course {string}", signedIn);
      When("she shares a snippet of {int} bytes named {string} from {string}", async (_ctx, bytes: number, filename: string, lab: string) => {
        shared = await share("x".repeat(bytes), filename, lab);
      });
      Then("the reader shall refuse the share as {string}", refused);
      And("the reader shall keep {int} snippets for {string}", kept);
    });
  });

  Rule("When a snippet is kept, the reader shall publish on the course's snippets topic a notice that carries the course id, a notice id and the time and nothing else.", ({ RuleScenario }) => {
    RuleScenario("The ping carries no content", ({ Given, When, Then, And }) => {
      Given("{string} is signed in to the course {string}", signedIn);
      When("she shares the snippet {string} named {string} from {string}", sharesSnippet);
      Then("the reader shall publish one {string} notice for {string}", published);
      And("the notice shall carry only the fields {string}", (_ctx, fields: string) => {
        const notice = notices.posted[0] as Record<string, unknown>;
        expect(Object.keys(notice).sort()).toEqual(list(fields).sort());
        expect(notice.courseId).toBe(courseId);
        expect(typeof notice.id).toBe("string");
        expect(notice.sentAt).toBe(sharedAt);
      });
    });
    RuleScenario("A refused share publishes nothing", ({ Given, When, Then }) => {
      Given("{string} is signed in to the course {string}", signedIn);
      When("she shares the snippet {string} named {string} from {string}", sharesSnippet);
      Then("the reader shall publish no notice", () => expect(notices.posted).toHaveLength(0));
    });
  });

  Rule("While a signed-in person is listed as an educator in the course's published enrollment, the time dashboard shall show them the course's snippets that have not expired, newest first.", ({ RuleScenario }) => {
    let source: InMemoryCourseSource;
    let check: EducatorCheck;
    let shown: SharedSnippet[];

    const publishedCourse = (_ctx: unknown, course: string, educators: string) => {
      freshReader();
      source = new InMemoryCourseSource({ [course]: { enrollment: { educators: list(educators) } } });
    };
    const sharedAgo = async (_ctx: unknown, login: string, content: string, course: string, hours: number) => {
      const at = new FixedClock(clock.nowMs() - hours * HOUR);
      const past = new InMemorySnippetStore(at);
      await shareSnippet({ store: past, notices, clock: at })({ courseId: course, filename: "s.txt", content }, { login, name: login });
      store.rows.push(...past.rows);
    };
    /** The time dashboard's snippets page: the educator check, then the store, as the page's load does. */
    const opens = async (_ctx: unknown, login: string, course: string) => {
      check = await isCourseEducator(courseEducators({ source }))(course, login);
      shown = check.ok ? await activeSnippets({ store, clock })(course) : [];
    };
    const refusedWith = (_ctx: unknown, reason: string) => expect(check).toEqual({ ok: false, reason });

    RuleScenario("An educator reads the room", ({ Given, And, When, Then }) => {
      Given("the course {string} is published with the educators {string}", publishedCourse);
      And("these snippets were shared with {string}:", async (_ctx, course: string, table: Array<{ student: string; snippet: string; "hours ago": string }>) => {
        for (const row of table) await sharedAgo(_ctx, row.student, row.snippet, course, Number(row["hours ago"]));
      });
      When("{string} opens the snippets page for {string}", opens);
      Then("the time dashboard shall show the snippets {string}", (_ctx, contents: string) => {
        expect(check.ok).toBe(true);
        expect(shown.map((s) => s.content)).toEqual(list(contents));
      });
    });
    RuleScenario("A student is refused", ({ Given, And, When, Then }) => {
      Given("the course {string} is published with the educators {string}", publishedCourse);
      And("{string} shared the snippet {string} with {string} {int} hours ago", sharedAgo);
      When("{string} opens the snippets page for {string}", opens);
      Then("the time dashboard shall refuse with the reason {string}", refusedWith);
    });
    RuleScenario("A course with no enrollment admits nobody", ({ Given, When, Then }) => {
      Given("the course {string} is published with no enrollment", (_ctx, course: string) => {
        freshReader();
        source = new InMemoryCourseSource({ [course]: { title: "A course" } });
      });
      When("{string} opens the snippets page for {string}", opens);
      Then("the time dashboard shall refuse with the reason {string}", refusedWith);
    });
    RuleScenario("A visitor who is not signed in is refused before the course is read", ({ Given, When, Then, And }) => {
      Given("the course {string} is published with the educators {string}", publishedCourse);
      When("a visitor who is not signed in opens the snippets page for {string}", async (_ctx, course: string) => {
        check = await isCourseEducator(courseEducators({ source }))(course, null);
      });
      Then("the time dashboard shall refuse with the reason {string}", refusedWith);
      And("the course is never read", () => expect(source.loads).toHaveLength(0));
    });
  });

  // The lecturer's broadcasts: the reader's server runs the use case over the composed notices; each
  // student tab hears through the notice service.
  let lecturer: string;
  let limiter = createBroadcastLimiter();
  let result: BroadcastResult;
  let toasts: Map<string, LecturerBroadcast[]>;

  const lecturerOf = (_ctx: unknown, name: string, course: string) => {
    freshReader();
    limiter = createBroadcastLimiter();
    lecturer = name;
    courseId = course;
  };
  const reading = (_ctx: unknown, a: string, b: string, course: string) => {
    if (!notices) freshReader();
    courseId = course;
    toasts = new Map([a, b].map((s) => [s, []]));
    for (const student of [a, b]) noticeService.onLecturerBroadcast(course, (toast) => toasts.get(student)!.push(toast));
  };
  const broadcast = (course: string, title: string, description: string, actionLabel = "", actionUrl = "") =>
    broadcastToCourse({ notices, clock, limiter })(course, { title, description, actionUrl, actionLabel }, lecturer);
  const broadcasts = async (_ctx: unknown, title: string, description: string, label: string, url: string) => {
    result = await broadcast(courseId, title, description, label, url);
  };
  const broadcastAgo = async (_ctx: unknown, title: string, description: string, seconds: number) => {
    expect((await broadcast(courseId, title, description)).ok).toBe(true);
    clock.advance(seconds * 1000);
    notices.posted.length = 0;
  };
  const eachSees = (_ctx: unknown, a: string, b: string, title: string, sender: string, label: string) => {
    for (const student of [a, b]) {
      const seen = toasts.get(student)!;
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ title, senderName: sender, actionLabel: label || undefined });
    }
  };

  Rule("When a lecturer broadcasts a message to a course, the reader shall deliver the message with the lecturer's name to every student reading the course.", ({ RuleScenario }) => {
    RuleScenario("The quiz is open", ({ Given, And, When, Then }) => {
      Given("{string} is a lecturer of {string}", lecturerOf);
      And("{string} and {string} are reading {string}", reading);
      When("the lecturer broadcasts {string} saying {string} with the action {string} to {string}", broadcasts);
      Then("the reader shall publish one {string} notice for {string}", published);
      And("{string} and {string} shall each see the toast {string} from {string} with the action {string}", eachSees);
    });
    RuleScenario("A lecturer with no name is shown as Tutor", ({ Given, And, When, Then }) => {
      Given("{string} is a lecturer of {string}", lecturerOf);
      And("{string} and {string} are reading {string}", reading);
      When("the lecturer broadcasts {string} saying {string} with the action {string} to {string}", broadcasts);
      Then("{string} and {string} shall each see the toast {string} from {string} with the action {string}", eachSees);
    });
  });

  Rule("If a course was broadcast to less than 60 seconds ago, then the reader shall refuse the next broadcast to that course.", ({ RuleScenario }) => {
    RuleScenario("Two broadcasts in a minute", ({ Given, And, When, Then }) => {
      Given("{string} is a lecturer of {string}", lecturerOf);
      And("the lecturer broadcast {string} saying {string} {int} seconds ago", broadcastAgo);
      When("the lecturer broadcasts {string} saying {string} with the action {string} to {string}", broadcasts);
      Then("the reader shall refuse the broadcast as {string}", (_ctx, reason: string) => {
        expect(result).toEqual({ ok: false, reason });
        expect(notices.posted).toHaveLength(0);
      });
    });
    RuleScenario("The minute passes", ({ Given, And, When, Then }) => {
      Given("{string} is a lecturer of {string}", lecturerOf);
      And("the lecturer broadcast {string} saying {string} {int} seconds ago", broadcastAgo);
      When("the lecturer broadcasts {string} saying {string} with the action {string} to {string}", broadcasts);
      Then("the reader shall publish one {string} notice for {string}", published);
    });
    RuleScenario("Another course is unaffected", ({ Given, And, When, Then }) => {
      Given("{string} is a lecturer of {string}", lecturerOf);
      And("the lecturer broadcast {string} saying {string} {int} seconds ago", broadcastAgo);
      When("the lecturer broadcasts {string} saying {string} with the action {string} to {string} on {string}", async (_ctx, title: string, description: string, label: string, url: string, course: string) => {
        result = await broadcast(course, title, description, label, url);
      });
      Then("the reader shall publish one {string} notice for {string}", published);
    });
  });

  Rule("The reader shall show a lecturer's broadcast once in each tab, however many times its notice arrives.", ({ RuleScenario }) => {
    const notice = (id: string, sender: string, title: string, course: string): CourseNotice => ({ type: "course:broadcast", id, courseId: course, title, description: "d", senderName: sender, sentAt: 1 });
    const eachSeesCount = (_ctx: unknown, a: string, b: string, count: number) => {
      for (const student of [a, b]) expect(toasts.get(student)!).toHaveLength(count);
    };
    RuleScenario("A replayed notice", ({ Given, When, Then }) => {
      Given("{string} and {string} are reading {string}", reading);
      When("the notice {string} from {string} titled {string} arrives {int} times", async (_ctx, id: string, sender: string, title: string, times: number) => {
        for (let i = 0; i < times; i++) await notices.post(notice(id, sender, title, courseId));
      });
      Then("{string} and {string} shall each see {int} toast", eachSeesCount);
    });
    RuleScenario("A broadcast to another course", ({ Given, When, Then }) => {
      Given("{string} and {string} are reading {string}", reading);
      When("the notice {string} from {string} titled {string} arrives for {string}", async (_ctx, id: string, sender: string, title: string, course: string) => {
        await notices.post(notice(id, sender, title, course));
      });
      Then("{string} and {string} shall each see {int} toasts", eachSeesCount);
    });
  });

  Rule("While the reader is composed for anonymous use, the reader shall offer no snippet sharing and hear no broadcast.", ({ RuleScenario }) => {
    let heard: LecturerBroadcast[];
    let outcome: { ok: boolean };
    const tries = async (_ctx: unknown, login: string, course: string) => {
      heard = [];
      noticeService.onLecturerBroadcast(course, (toast) => heard.push(toast));
      outcome = await snippetService.share({ courseId: course, filename: "a.txt", content: "x" }, { login, name: login });
    };
    const aBroadcast = async (course: string) => {
      await notices.post({ type: "course:broadcast", id: "bc-anon", courseId: course, title: "t", description: "d", senderName: "T", sentAt: 1 });
    };
    RuleScenario("The anonymous reader", ({ Given, When, Then, And }) => {
      Given("the reader is composed for anonymous use", () => {
        freshReader();
        configureAdapters({ anonymous: true });
      });
      When("{string} tries to share a snippet with {string}", tries);
      Then("the reader shall offer no snippet sharing", () => {
        expect(snippetService.enabled()).toBe(false);
        expect(outcome.ok).toBe(false);
        expect(store.rows).toHaveLength(0);
      });
      And("a broadcast to {string} shall reach no tab", async (_ctx, course: string) => {
        await aBroadcast(course);
        expect(heard).toHaveLength(0);
      });
    });
    RuleScenario("The signed-in reader", ({ Given, When, Then, And }) => {
      Given("the reader is composed with a sign-in", freshReader);
      When("{string} tries to share a snippet with {string}", tries);
      Then("the reader shall offer snippet sharing", () => {
        expect(snippetService.enabled()).toBe(true);
        expect(outcome.ok).toBe(true);
        expect(store.rows).toHaveLength(1);
      });
      And("a broadcast to {string} shall reach the tab", async (_ctx, course: string) => {
        await aBroadcast(course);
        expect(heard).toHaveLength(1);
      });
    });
  });
});
