import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { expect, vi } from "vitest";

// The seams: the `pg` driver (the in-process store, backend.ts), the environments and SvelteKit.
vi.mock("pg", async () => (await import("../../support/backend.ts")).pgModule);
vi.mock("$app/env/public", async () => {
  const { publicEnv } = await import("../../support/backend.ts");
  const { READER_ORIGIN } = await import("../../support/reader-api.ts");
  return Object.assign(publicEnv, { PUBLIC_READER_URL: READER_ORIGIN });
});
vi.mock("$app/env/private", async () => (await import("../../support/backend.ts")).privateEnv);
vi.mock("$app/env", () => ({ browser: true, building: false, goto: vi.fn() }));

import type { Course, Lo } from "../../../../packages/jsr/model/src/tutors.ts";
import { load as loadTimeCourse } from "../../../../apps/time/src/routes/[courseid]/(calendar-lab)/+layout.ts";
import { load as loadCataloguePage } from "../../../../apps/catalogue/src/routes/+page.ts";
import { scanBrowserCode } from "../../../../scripts/checks/browser-data-access.ts";
import { freshBrowser, githubUser, labsOf, openLo, publishedCourse, signIn } from "../../support/connect.ts";
import { apiRequests, readerRequest, serveCourseJson, setReaderSession, takeCourseHostDown } from "../../support/reader-api.ts";
import { backend, privateEnv } from "../../support/backend.ts";
import { tutorsId } from "../../../../packages/adapters/driving/svelte-state/src/index.svelte.ts";

const feature = await loadFeature("tests/bdd/features/shared/server-data-access.feature");

const STUDENT_TABLES = ["learning_records", "calendar", "tutors-connect-users", "tutors-connect-latest", "tutors-connect-profiles", "whiteboard_scenes"];
const capitalised = (login: string) => login[0].toUpperCase() + login.slice(1);

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function personalRoom(course: Course, lo: Lo, login: string): string {
  return `wb-personal:${encodeURIComponent(course.courseId)}:${encodeURIComponent(lo.route)}:${encodeURIComponent(login)}`;
}

/** The catalogue page's data, loaded as the catalogue app loads it: from the reader at PUBLIC_READER_URL. */
const openCatalogue = () =>
  loadCataloguePage({ fetch: globalThis.fetch } as Parameters<typeof loadCataloguePage>[0]) as Promise<{ courseRecords: unknown[]; studentCount: number }>;

const DATABASE_URL = privateEnv.PRIVATE_DATABASE_URL;

type TimeData = { role: string; calendar: Record<string, unknown>[]; learningRecords: Record<string, unknown>[]; users: Record<string, unknown>[] };

describeFeature(feature, ({ Background, AfterEachScenario, Rule }) => {
  let course: Course;
  let response: Response;
  let body: unknown;
  let timeCourse: { calendarModel: { week: { rows: { full_name: string }[] } } } | null;

  const firstLab = () => labsOf(course)[0];
  const expectCourse = (courseId: string) => expect(course.courseId).toBe(courseId);

  async function answer(r: Response) {
    response = r;
    body = r.headers.get("content-type")?.includes("application/json") ? await r.json() : await r.text();
  }

  const nobodySignedIn = () => {
    setReaderSession(null);
    tutorsId.value = null;
  };
  const signedIn = (_ctx: unknown, name: string) => signIn(githubUser(name));
  const readerAnswers = (_ctx: unknown, status: number) => expect(response.status).toBe(status);
  /** No statement reached the store since the scenario's Given steps (seeds go in directly, unlogged). */
  const nothingTouched = () => {
    expect(backend.queries).toEqual([]);
  };

  const postPageLoad = async (_ctx: unknown, courseId: string, named: string) => {
    expectCourse(courseId);
    await answer(await readerRequest("POST", "/api/analytics", { kind: "page-load", courseId, loId: firstLab().route, loType: "lab", day: today(), studentId: named }));
  };

  async function seedStudents(courseId: string, logins: string[]) {
    expectCourse(courseId);
    for (const login of logins) {
      await backend.seed("learning_records", [
        { course_id: courseId, student_id: login, lo_id: firstLab().route, duration: 4, count: 2, date_last_accessed: "2026-09-21T10:00:00Z", type: "lab" }
      ]);
      await backend.seed("calendar", [{ id: "2026-09-21", studentid: login, courseid: courseId, timeactive: 10, pageloads: 3 }]);
      await backend.seed("tutors-connect-users", [
        {
          github_id: login,
          full_name: capitalised(login),
          avatar_url: `https://avatars.example/${login}.png`,
          email: `${login}@example.com`,
          sentiment: "fine",
          online_status: "online"
        }
      ]);
    }
  }
  const seedThree = (_ctx: unknown, a: string, b: string, c: string, courseId: string) => seedStudents(courseId, [a, b, c]);
  const askTimeData = async (_ctx: unknown, courseId: string) => {
    expectCourse(courseId);
    await answer(await readerRequest("GET", `/api/time/${courseId}`));
  };
  const timeData = () => body as TimeData;
  const idsIn = (data: TimeData) => new Set([...data.calendar.map((r) => r.studentid), ...data.learningRecords.map((r) => r.student_id)]);

  const saveDrawing = async (who: string | null, courseId: string) => {
    expectCourse(courseId);
    await answer(
      await readerRequest("PUT", "/api/whiteboard", { courseId, route: firstLab().route, shared: false, elements: [{ id: `${who ?? "anonymous"}-rect`, type: "rectangle" }] })
    );
  };

  const askToLock = async (_ctx: unknown, courseId: string) => {
    expectCourse(courseId);
    await answer(await readerRequest("PUT", "/api/locks", { courseId, loRoute: firstLab().route, locked: true }));
  };
  const noLocks = async (_ctx: unknown, courseId: string) => {
    expect((await backend.rows("tutors_content_locks")).filter((r) => r.course_id === courseId)).toEqual([]);
  };
  const lockedBy = async (_ctx: unknown, courseId: string, login: string) => {
    expect(await backend.rows("tutors_content_locks")).toMatchObject([{ course_id: courseId, lo_route: firstLab().route, locked: true, locked_by: login }]);
  };
  const publishWithEducator = (_ctx: unknown, courseId: string, educator: string) => {
    course = publishedCourse(courseId, 1, {}, { educators: [educator], whitelist: [], students: [] });
  };
  /** The reader consults the course's educators `minutes` ago (Eve opens its time data then), and the clock returns to now. */
  const readEducatorsAgo = async (_ctx: unknown, courseId: string, minutes: number) => {
    expectCourse(courseId);
    const now = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now - minutes * 60_000);
    setReaderSession(githubUser("Eve"));
    await readerRequest("GET", `/api/time/${courseId}`);
    setReaderSession(null);
    vi.setSystemTime(now);
  };
  const hostDown = (_ctx: unknown, courseId: string) => takeCourseHostDown(courseId);

  AfterEachScenario(() => {
    privateEnv.PRIVATE_DATABASE_URL = DATABASE_URL;
  });

  /** Forgets the statements the Given steps made, so a Then about the request under test sees only its own. */
  const forgetCalls = () => {
    backend.queries.length = 0;
  };
  const scormRow = (login: string) => ({
    course_id: course.courseId,
    student_id: login,
    lo_id: firstLab().route,
    scorm_version: "1.2",
    cmi: { "cmi.core.lesson_location": `${login}-page-3` }
  });
  const handIn = (login: string) => ({
    student_id: login,
    student_name: capitalised(login),
    course_id: course.courseId,
    lo_id: firstLab().route,
    runtime: "python",
    entry: "main.py",
    files: [{ path: "main.py", content: `print('${login}')` }],
    last_output: "",
    last_ok: null,
    updated_at: new Date().toISOString()
  });
  const handInsOnFirstLab = async () => (await backend.rows("playground_snapshots")).filter((r) => r.course_id === course.courseId && r.lo_id === firstLab().route);

  Background(({ Given }) => {
    Given("the course {string} is published with {number} labs and {string} as its educator", async (_ctx, courseId: string, labs: number, educator: string) => {
      await freshBrowser();
      course = publishedCourse(courseId, labs, {}, { educators: [educator], whitelist: [], students: [] });
    });
  });

  Rule(
    "If a request to record, read or change a student's data reaches the reader without a signed-in session, then the reader shall answer 401 and read or write no row.",
    ({ RuleScenario }) => {
      RuleScenario("An anonymous page load is refused", ({ Given, When, Then, And }) => {
        Given("nobody is signed in to the reader", nobodySignedIn);
        When("the browser posts a page load of the first lab of {string} naming the student {string}", postPageLoad);
        Then("the reader answers {number}", readerAnswers);
        And("no row is read from or written to the database", nothingTouched);
      });

      RuleScenario("An anonymous request for a course's time data is refused", ({ Given, When, Then, And }) => {
        Given("{string}, {string} and {string} have learning records and calendar rows in {string}", seedThree);
        And("nobody is signed in to the reader", nobodySignedIn);
        When("the browser asks the reader for the time data of {string}", askTimeData);
        Then("the reader answers {number}", readerAnswers);
        And("no row is read from or written to the database", nothingTouched);
      });
    }
  );

  Rule(
    "The reader shall store a signed-in student's learning records, calendar, sentiment, online status and shared presence under the GitHub login of the session, whatever student id the request names.",
    ({ RuleScenario }) => {
      RuleScenario("A request naming another student is stored under the session's login", ({ Given, When, Then, And }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("the browser posts a page load of the first lab of {string} naming the student {string}", async (ctx, courseId: string, named: string) => {
          await postPageLoad(ctx, courseId, named);
          expect(response.status).toBe(204);
        });
        And(
          "the browser sets the sentiment {string} and the online status {string} naming the student {string}",
          async (_ctx, sentiment: string, onlineStatus: string, named: string) => {
            await answer(await readerRequest("PATCH", "/api/me", { sentiment, onlineStatus, githubId: named }));
            expect(response.status).toBe(204);
          }
        );
        And("the browser shares presence on the first lab of {string} naming the student {string}", async (_ctx, courseId: string, named: string) => {
          expectCourse(courseId);
          const payload = {
            courseId,
            loRoute: firstLab().route,
            title: firstLab().title,
            type: "lab",
            user: { id: named, fullName: capitalised(named), avatar: `https://avatars.example/${named}.png`, sentiment: "neutral" }
          };
          await answer(await readerRequest("POST", "/api/presence", { courseId, payload }));
          expect(response.status).toBe(204);
        });
        Then("the learning record, calendar row and presence row are stored under {string}", async (_ctx, login: string) => {
          expect((await backend.rows("learning_records")).map((r) => r.student_id)).toEqual([login]);
          expect((await backend.rows("calendar")).map((r) => r.studentid)).toEqual([login]);
          expect(await backend.rows("tutors-connect-latest")).toMatchObject([{ course_id: course.courseId, student_id: login, payload: { user: { id: login } } }]);
        });
        And("the user row of {string} has the sentiment {string} and the online status {string}", async (_ctx, login: string, sentiment: string, onlineStatus: string) => {
          expect((await backend.rows("tutors-connect-users")).find((r) => r.github_id === login)).toMatchObject({ sentiment, online_status: onlineStatus });
        });
        And("nothing is stored under {string}", async (_ctx, login: string) => {
          for (const table of STUDENT_TABLES) expect(JSON.stringify(await backend.rows(table)), table).not.toContain(`"${login}"`);
        });
      });

      RuleScenario("A signed-in student's lab visit reaches the database only through the reader's server", ({ Given, When, Then, And }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("{string} opens the first lab of {string}", async (_ctx, _name: string, courseId: string) => {
          expectCourse(courseId);
          await openLo(course, firstLab());
        });
        Then("the learning record and calendar row are stored under {string}", async (_ctx, login: string) => {
          expect(await backend.rows("learning_records")).toMatchObject([{ course_id: course.courseId, student_id: login, lo_id: firstLab().route, type: "lab" }]);
          expect(await backend.rows("calendar")).toMatchObject([{ studentid: login, courseid: course.courseId }]);
        });
        And("the browser posted the lab visit to the reader's server with the session of {string}", (_ctx, login: string) => {
          const visits = apiRequests.filter((r) => r.method === "POST" && r.url === "/api/analytics");
          expect(visits).toMatchObject([{ origin: null, sessionLogin: login, status: 204, body: { kind: "page-load", courseId: course.courseId, loId: firstLab().route } }]);
        });
      });
    }
  );

  Rule(
    "If a signed-in user who is not an educator of a course asks the reader to lock or unlock its content, then the reader shall answer 403 and leave the course's locks unchanged.",
    ({ RuleScenario }) => {
      RuleScenario("A student cannot lock a course's content", ({ Given, When, Then, And }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("the browser asks the reader to lock the first lab of {string}", askToLock);
        Then("the reader answers {number}", readerAnswers);
        And("{string} has no content locks", noLocks);
      });

      RuleScenario("The course's educator can lock its content", ({ Given, When, Then, And }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("the browser asks the reader to lock the first lab of {string}", askToLock);
        Then("the reader answers {number}", readerAnswers);
        And("the first lab of {string} is locked by {string}", lockedBy);
      });
    }
  );

  Rule(
    "If the reader cannot read a course's educators from its host and holds no copy read within the last hour, then the reader shall answer 503 to a request that needs them and leave the course's locks unchanged.",
    ({ RuleScenario }) => {
      RuleScenario("The course host is down and the reader never read the course", ({ Given, When, Then, And }) => {
        Given("the course {string} is published with {string} as its educator", publishWithEducator);
        And("the host of {string} is unreachable", hostDown);
        And("{string} is signed in to the reader", signedIn);
        When("the browser asks the reader to lock the first lab of {string}", askToLock);
        Then("the reader answers {number}", readerAnswers);
        And("{string} has no content locks", noLocks);
      });

      RuleScenario("The course host is down and the reader's copy is older than an hour", ({ Given, When, Then, And }) => {
        Given("the course {string} is published with {string} as its educator", publishWithEducator);
        And("the reader read the educators of {string} {number} minutes ago", readEducatorsAgo);
        And("the host of {string} is unreachable", hostDown);
        And("{string} is signed in to the reader", signedIn);
        When("the browser asks the reader to lock the first lab of {string}", askToLock);
        Then("the reader answers {number}", readerAnswers);
        And("{string} has no content locks", noLocks);
      });
    }
  );

  Rule("While a course's host is unreachable, the reader shall decide who teaches the course from the copy of its educators it read within the last hour.", ({ RuleScenario }) => {
    RuleScenario("An educator locks content while the course host is briefly down", ({ Given, When, Then, And }) => {
      Given("the course {string} is published with {string} as its educator", publishWithEducator);
      And("the reader read the educators of {string} {number} minutes ago", readEducatorsAgo);
      And("the host of {string} is unreachable", hostDown);
      And("{string} is signed in to the reader", signedIn);
      When("the browser asks the reader to lock the first lab of {string}", askToLock);
      Then("the reader answers {number}", readerAnswers);
      And("the first lab of {string} is locked by {string}", lockedBy);
    });

    RuleScenario("With the course host up, a removed educator loses the lock at once", ({ Given, When, Then, And }) => {
      Given("the course {string} is published with {string} as its educator", publishWithEducator);
      And("the reader read the educators of {string} {number} minutes ago", readEducatorsAgo);
      And("{string} is republished without {string} as an educator", (_ctx, courseId: string) => {
        expectCourse(courseId);
        serveCourseJson(courseId, { title: course.title, properties: {}, enrollment: { educators: [], whitelist: [], students: [] } });
      });
      And("{string} is signed in to the reader", signedIn);
      When("the browser asks the reader to lock the first lab of {string}", askToLock);
      Then("the reader answers {number}", readerAnswers);
      And("{string} has no content locks", noLocks);
    });
  });

  Rule(
    "While a signed-in viewer is not an educator of a course, the reader shall return the course's time data with every other student's id replaced by a pseudonym and without any other student's name, avatar, sentiment or online status.",
    ({ RuleScenario }) => {
      RuleScenario("A student sees their own time and anonymous classmates", ({ Given, When, Then, And }) => {
        Given("{string}, {string} and {string} have learning records and calendar rows in {string}", seedThree);
        And("{string} is signed in to the reader", signedIn);
        When("the browser asks the reader for the time data of {string}", askTimeData);
        Then("the reader answers {number}", readerAnswers);
        And("the time data holds the rows of {string} under {string}", (_ctx, _owner: string, login: string) => {
          expect(timeData().calendar.filter((r) => r.studentid === login)).toHaveLength(1);
          expect(timeData().learningRecords.filter((r) => r.student_id === login)).toHaveLength(1);
        });
        And("the time data holds the other students' rows under {number} pseudonyms that are not their logins", (_ctx, count: number) => {
          const others = [...idsIn(timeData())].filter((id) => id !== tutorsId.value?.login) as string[];
          expect(others).toHaveLength(count);
          for (const pseudonym of others) expect(["alice", "bob", "carol"]).not.toContain(pseudonym);
        });
        And("the time data names no student other than {string}", (_ctx, login: string) => {
          expect(timeData().users.map((u) => u.github_id)).toEqual([login]);
          const text = JSON.stringify(body);
          for (const other of ["alice", "bob"]) {
            expect(text).not.toContain(other);
            expect(text).not.toContain(capitalised(other));
          }
        });
      });

      RuleScenario("The course's educator sees every student by name", ({ Given, When, Then, And }) => {
        Given("{string}, {string} and {string} have learning records and calendar rows in {string}", seedThree);
        And("{string} is signed in to the reader", signedIn);
        When("the browser asks the reader for the time data of {string}", askTimeData);
        Then("the reader answers {number}", readerAnswers);
        And("the time data holds the rows of {string}, {string} and {string} with their names and avatars", (_ctx, a: string, b: string, c: string) => {
          expect([...idsIn(timeData())].sort()).toEqual([a, b, c]);
          for (const login of [a, b, c]) {
            expect(timeData().users.find((u) => u.github_id === login)).toMatchObject({ full_name: capitalised(login), avatar_url: `https://avatars.example/${login}.png` });
          }
        });
      });
    }
  );

  Rule(
    "When a viewer who is not an educator of a course asks for its time data again, the reader shall give the other students pseudonyms that differ from the ones it gave before.",
    ({ RuleScenario }) => {
      RuleScenario("Pseudonyms do not link one answer to the next", ({ Given, When, Then, And }) => {
        const answers: TimeData[] = [];
        const others = (data: TimeData) => new Set([...idsIn(data)].filter((id) => id !== tutorsId.value?.login));
        Given("{string}, {string} and {string} have learning records and calendar rows in {string}", seedThree);
        And("{string} is signed in to the reader", signedIn);
        When("the browser asks the reader for the time data of {string} twice", async (_ctx, courseId: string) => {
          for (let i = 0; i < 2; i++) {
            await askTimeData(_ctx, courseId);
            expect(response.status).toBe(200);
            answers.push(timeData());
          }
        });
        Then("each answer gives every other student one pseudonym across its calendar and learning records", () => {
          for (const data of answers) {
            const inCalendar = new Set(data.calendar.map((r) => r.studentid).filter((id) => id !== tutorsId.value?.login));
            const inRecords = new Set(data.learningRecords.map((r) => r.student_id).filter((id) => id !== tutorsId.value?.login));
            expect([...inCalendar].sort()).toEqual([...inRecords].sort());
            expect(inCalendar.size).toBe(2);
          }
        });
        And("no pseudonym in the second answer appears in the first", () => {
          const first = others(answers[0]);
          for (const pseudonym of others(answers[1])) expect(first.has(pseudonym)).toBe(false);
        });
      });
    }
  );

  Rule(
    "When a viewer opens a course in the time dashboard, the time dashboard shall load the course's time data from the reader's API with the viewer's reader session instead of from the database.",
    ({ RuleScenario }) => {
      RuleScenario("A lecturer opens a course in the time dashboard", ({ Given, When, Then, And }) => {
        Given("{string} and {string} have learning records and calendar rows in {string}", (_ctx, a: string, b: string, courseId: string) => seedStudents(courseId, [a, b]));
        And("{string} is signed in to the reader", signedIn);
        When("{string} opens {string} in the time dashboard", async (_ctx, _name: string, courseId: string) => {
          const data = (await loadTimeCourse({ params: { courseid: courseId } } as unknown as Parameters<typeof loadTimeCourse>[0])) as { course: typeof timeCourse };
          timeCourse = data.course;
        });
        Then("the time dashboard asked the reader for {string} with the viewer's reader session", (_ctx, path: string) => {
          expect(apiRequests.filter((r) => r.url === path)).toMatchObject([
            { method: "GET", credentials: "include", origin: "https://time.test", sessionLogin: "eve", status: 200 }
          ]);
        });
        And("the time dashboard's calendar lists {string} and {string}", (_ctx, a: string, b: string) => {
          expect(timeCourse?.calendarModel.week.rows.map((r) => r.full_name).sort()).toEqual([a, b]);
        });
      });
    }
  );

  Rule(
    "While a student is signed in, the reader shall save the student's edits to a whiteboard learning object in a room that only that student's session can read or overwrite.",
    ({ RuleScenario }) => {
      RuleScenario("Each signed-in student's whiteboard edits are saved in their own room", ({ Given, When, Then, And }) => {
        const savesDrawing = async (_ctx: unknown, name: string, courseId: string) => {
          await saveDrawing(name, courseId);
          expect(response.status).toBe(204);
        };
        Given("{string} is signed in to the reader", signedIn);
        And("{string} has saved a drawing on the whiteboard of the first lab of {string}", savesDrawing);
        When("{string} is signed in to the reader", signedIn);
        And("{string} saves a drawing on the whiteboard of the first lab of {string}", savesDrawing);
        Then(
          "the whiteboard of the first lab holds the drawing of {string} for {string} and the drawing of {string} for {string}",
          async (_ctx, a: string, aLogin: string, b: string, bLogin: string) => {
            const scenes = await backend.rows("whiteboard_scenes");
            expect(scenes.find((s) => s.room_id === personalRoom(course, firstLab(), aLogin))?.elements).toEqual([{ id: `${a}-rect`, type: "rectangle" }]);
            expect(scenes.find((s) => s.room_id === personalRoom(course, firstLab(), bLogin))?.elements).toEqual([{ id: `${b}-rect`, type: "rectangle" }]);
            expect(scenes).toHaveLength(2);
          }
        );
        And("the reader gives {string} back only the drawing of {string}", async (_ctx, _viewer: string, owner: string) => {
          const query = new URLSearchParams({ courseId: course.courseId, route: firstLab().route, shared: "false" });
          await answer(await readerRequest("GET", `/api/whiteboard?${query}`));
          expect(response.status).toBe(200);
          expect(body).toMatchObject({ scene: { elements: [{ id: `${owner}-rect` }] } });
        });
        And("a public shared route cannot read {string}'s personal drawing", async (_ctx, owner: string) => {
          const query = new URLSearchParams({ courseId: course.courseId, route: `${firstLab().route}-${owner.toLowerCase()}`, shared: "true" });
          await answer(await readerRequest("GET", `/api/whiteboard?${query}`));
          expect(response.status).toBe(200);
          expect(body).toEqual({ scene: null });
        });
      });

      RuleScenario("An anonymous visitor's whiteboard edits are not saved", ({ Given, When, Then, And }) => {
        Given("nobody is signed in to the reader", nobodySignedIn);
        When("the browser saves a drawing on the whiteboard of the first lab of {string}", (_ctx, courseId: string) => saveDrawing(null, courseId));
        Then("the reader answers {number}", readerAnswers);
        And("no whiteboard scene is stored", async () => {
          expect(await backend.rows("whiteboard_scenes")).toEqual([]);
        });
      });
    }
  );

  Rule("When a visitor opens the catalogue, the catalogue shall show the number of students without reading any student's profile.", ({ RuleScenario }) => {
    RuleScenario("The student count comes from a count, not from the profiles", ({ Given, When, Then, And }) => {
      let shown = 0;
      Given("{number} students have course-visit profiles", async (_ctx, count: number) => {
        await backend.seed(
          "tutors-connect-profiles",
          Array.from({ length: count }, (_, i) => ({ tutorId: `student${i}`, profile: [] }))
        );
      });
      When("a visitor opens the catalogue", async () => {
        forgetCalls();
        shown = (await openCatalogue()).studentCount;
      });
      Then("the catalogue shows {number} students", (_ctx, count: number) => {
        expect(shown).toBe(count);
      });
      And("no student's profile was read", () => {
        // The profiles were only counted: one row (the count) came back, and no column of a profile was selected.
        const onProfiles = backend.queriesOn("tutors-connect-profiles");
        expect(onProfiles.length).toBeGreaterThan(0);
        for (const query of onProfiles) {
          expect(query.text).toMatch(/^\s*SELECT count\(\*\)(::\w+)?( AS \w+)? FROM "tutors-connect-profiles"\s*$/i);
          expect(query.returned).toBe(1);
        }
      });
    });
  });

  Rule("Tutors shall read and change data from the browser only through the reader's server, with no browser code calling a database table or function.", ({ RuleScenario }) => {
    RuleScenario("A lab visit and a catalogue visit go through the reader's server", ({ Given, When, Then, And }) => {
      Given("{string} is signed in to the reader", signedIn);
      When("she opens the first lab of {string}", async (_ctx, courseId: string) => {
        expectCourse(courseId);
        await openLo(course, firstLab());
      });
      And("a visitor opens the catalogue", async () => {
        await openCatalogue();
      });
      Then("the reader's server recorded the lab visit and answered the catalogue", async () => {
        expect((await backend.rows("learning_records")).length).toBeGreaterThan(0);
        expect(apiRequests.filter((r) => r.status < 300).map((r) => `${r.method} ${r.url}`)).toEqual(expect.arrayContaining(["POST /api/analytics", "GET /api/catalogue"]));
      });
      And("no browser code in the reader, catalogue, live or time apps calls a table or a database function", () => {
        expect(scanBrowserCode()).toEqual([]);
      });
    });
  });

  Rule("While a session is signed in, the reader shall answer each of its read routes with only what that session is allowed to see.", ({ RuleScenario }) => {
    const savedScorm = async (_ctx: unknown, name: string, courseId: string) => {
      expectCourse(courseId);
      await backend.seed("scorm_records", [scormRow(name.toLowerCase())]);
    };
    const askScorm = async (_ctx: unknown, courseId: string) => {
      expectCourse(courseId);
      forgetCalls();
      const query = new URLSearchParams({ courseId, loId: firstLab().route });
      await answer(await readerRequest("GET", `/api/scorm?${query}`));
    };

    RuleScenario("A student reads back only their own SCORM state", ({ Given, And, When, Then }) => {
      Given("{string} saved SCORM state on the first lab of {string}", savedScorm);
      And("{string} is signed in to the reader", signedIn);
      When("the browser asks the reader for the SCORM state of the first lab of {string}", askScorm);
      Then("the reader answers {number}", readerAnswers);
      And("the answer holds no SCORM state", () => {
        expect(body).toEqual({ cmi: {} });
      });
    });

    RuleScenario("An anonymous visitor reads no SCORM state", ({ Given, And, When, Then }) => {
      Given("{string} saved SCORM state on the first lab of {string}", savedScorm);
      And("nobody is signed in to the reader", nobodySignedIn);
      When("the browser asks the reader for the SCORM state of the first lab of {string}", askScorm);
      Then("the reader answers {number}", readerAnswers);
      And("no row is read from or written to the database", nothingTouched);
    });
  });

  Rule("If the reader's server has no database URL, then the reader shall answer 503 to each of its data routes and read or write no row.", ({ RuleScenarioOutline }) => {
    RuleScenarioOutline("A data route on a server without a database URL", ({ Given, And, When, Then }, variables) => {
      Given("{string} is signed in to the reader", signedIn);
      And("the reader's server has no database URL", () => {
        privateEnv.PRIVATE_DATABASE_URL = "";
        forgetCalls();
      });
      When("the browser calls the reader's <route> route for {string}", async (_ctx, courseId: string) => {
        expectCourse(courseId);
        const loId = firstLab().route;
        const calls: Record<string, () => Promise<Response>> = {
          catalogue: () => readerRequest("GET", "/api/catalogue"),
          "presence roster": () => readerRequest("GET", `/api/presence/roster?${new URLSearchParams({ courseId })}`),
          locks: () => readerRequest("GET", `/api/locks?${new URLSearchParams({ courseId })}`),
          SCORM: () => readerRequest("GET", `/api/scorm?${new URLSearchParams({ courseId, loId })}`),
          playground: () => readerRequest("GET", `/api/playground?${new URLSearchParams({ courseId, loId })}`),
          errors: () => readerRequest("POST", "/api/errors", { app: "tutors-reader", entries: [{ level: "error", message: "boom", courseId }] })
        };
        const call = calls[String(variables.route)];
        expect(call, String(variables.route)).toBeDefined();
        await answer(await call());
      });
      Then("the reader answers {number}", readerAnswers);
      And("no row is read from or written to the database", nothingTouched);
    });
  });

  Rule(
    "When a browser hands in or withdraws playground work, the reader shall store or remove only the signed-in student's own hand-in, whoever the request names and whether or not the session teaches the course.",
    ({ RuleScenario }) => {
      const onlyHandIn = async (_ctx: unknown, login: string) => {
        expect((await handInsOnFirstLab()).map((r) => r.student_id)).toEqual([login]);
      };

      RuleScenario("A hand-in naming another student is stored under the session's login", ({ Given, When, Then, And }) => {
        Given("{string} is signed in to the reader", signedIn);
        When("the browser hands in playground work on the first lab of {string} naming the student {string}", async (_ctx, courseId: string, named: string) => {
          expectCourse(courseId);
          await answer(
            await readerRequest("PUT", "/api/playground", {
              courseId,
              loId: firstLab().route,
              studentId: named,
              runtime: "python",
              entry: "main.py",
              files: [{ path: "main.py", content: "print('hi')" }]
            })
          );
        });
        Then("the reader answers {number}", readerAnswers);
        And("the only hand-in stored on the first lab is {string}'s", onlyHandIn);
      });

      RuleScenario("An educator cannot withdraw a student's hand-in", ({ Given, And, When, Then }) => {
        Given("{string} handed in playground work on the first lab of {string}", async (_ctx, name: string, courseId: string) => {
          expectCourse(courseId);
          await backend.seed("playground_snapshots", [handIn(name.toLowerCase())]);
        });
        And("{string} is signed in to the reader", signedIn);
        When("the browser withdraws the playground hand-in of {string} on the first lab of {string}", async (_ctx, login: string, courseId: string) => {
          expectCourse(courseId);
          await answer(await readerRequest("DELETE", "/api/playground", { courseId, loId: firstLab().route, studentId: login }));
        });
        Then("the reader answers {number}", readerAnswers);
        And("the only hand-in stored on the first lab is {string}'s", onlyHandIn);
      });
    }
  );
});
